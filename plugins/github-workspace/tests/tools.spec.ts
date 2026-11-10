import { createHash } from 'node:crypto'
import { lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { deflateRawSync, gzipSync } from 'node:zlib'
import { afterEach, expect, it, vi } from 'vitest'
import { execute } from '../src/process.js'
import { downloadRelease, GH_VERSION, releaseBinary, Tools } from '../src/tools.js'
import { WorkspaceError } from '../src/types.js'

const disposals: Array<() => Promise<void>> = []
afterEach(async () => { vi.unstubAllGlobals(); for (const dispose of disposals.splice(0).reverse()) await dispose() })
const digest = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex')
const script = Buffer.from('#!/bin/sh\nif [ "$1" = "--version" ]; then echo "gh version ' + GH_VERSION + ' (fixture)"; else echo "fixture-helper"; fi\n')
function tar(entry: string, data: Buffer, type = '0'): Buffer {
  const header = Buffer.alloc(512)
  header.write(entry); header.write(data.length.toString(8).padStart(11, '0') + '\0', 124); header.write(type, 156)
  return gzipSync(Buffer.concat([header, data, Buffer.alloc((512 - data.length % 512) % 512 + 1024)]))
}
function zip(entry: string, data: Buffer): Buffer {
  const name = Buffer.from(entry), compressed = deflateRawSync(data), local = Buffer.alloc(30), central = Buffer.alloc(46), end = Buffer.alloc(22)
  local.writeUInt32LE(0x04034b50); local.writeUInt16LE(8, 8); local.writeUInt32LE(compressed.length, 18); local.writeUInt32LE(data.length, 22); local.writeUInt16LE(name.length, 26)
  central.writeUInt32LE(0x02014b50); central.writeUInt16LE(8, 10); central.writeUInt32LE(compressed.length, 20); central.writeUInt32LE(data.length, 24); central.writeUInt16LE(name.length, 28); central.writeUInt32LE(0x81ed0000, 38)
  const offset = local.length + name.length + compressed.length
  end.writeUInt32LE(0x06054b50); end.writeUInt16LE(1, 8); end.writeUInt16LE(1, 10); end.writeUInt32LE(central.length + name.length, 12); end.writeUInt32LE(offset, 16)
  return Buffer.concat([local, name, compressed, central, name, end])
}
async function fixture(download?: typeof downloadRelease) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'github-tools-test-')))
  disposals.push(() => rm(root, { recursive: true, force: true }))
  const suffix = 'linux_amd64.tar.gz', archive = tar('gh_' + GH_VERSION + '_linux_amd64/bin/gh', script)
  const fetch = download ?? vi.fn(async () => archive), recipe = { suffix, hash: digest(archive) }
  const tools = new Tools(root, execute, async () => {}, fetch, false, recipe)
  disposals.push(() => tools.close())
  return { root, archive, tools, fetch, recipe }
}
it.each([false, true])('reads only the expected executable from a verified archive (zip=%s)', zipFormat => {
  const archive = (zipFormat ? zip : tar)('release/bin/gh', script)
  expect(releaseBinary(archive, digest(archive), 'release/bin/gh', zipFormat)).toEqual(script)
  expect(() => releaseBinary(archive, '0'.repeat(64), 'release/bin/gh', zipFormat)).toThrow('toolIntegrity')
  expect(() => releaseBinary(archive, digest(archive), '../bin/gh', zipFormat)).toThrow('toolIntegrity')
  const malformed = Buffer.from('invalid')
  expect(() => releaseBinary(malformed, digest(malformed), 'bin/gh', zipFormat)).toThrow('toolIntegrity')
})
it('rejects archive links and redirects outside official release hosts before making another request', async () => {
  const archive = tar('release/bin/gh', script, '2')
  expect(() => releaseBinary(archive, digest(archive), 'release/bin/gh', false)).toThrow('toolIntegrity')
  const fetch = vi.fn(async () => new Response('', { status: 302, headers: { location: 'https://untrusted.invalid/tool' } }))
  vi.stubGlobal('fetch', fetch)
  await expect(downloadRelease('https://github.com/cli/cli/releases/download/fixture', new AbortController().signal, () => {})).rejects.toMatchObject({ code: 'toolDownload' })
  expect(fetch).toHaveBeenCalledTimes(1)
})
it('installs once for concurrent waiters, runs the helper from its private PATH, and verifies the cache on restart', async () => {
  const f = await fixture()
  const paths = await Promise.all([f.tools.setup(), f.tools.setup()])
  expect(paths[0]).toBe(paths[1]); expect(f.fetch).toHaveBeenCalledTimes(1)
  expect(f.tools.state()).toMatchObject({ status: 'ready', source: 'managed' })
  expect((await f.tools.run('gh', ['--version'])).stdout).toContain(GH_VERSION)
  const helper = await f.tools.run('git', ['-c', 'credential.helper=', '-c', 'credential.helper=!gh auth git-credential', 'credential', 'fill'], {
    env: { GIT_TERMINAL_PROMPT: '0' }, input: 'protocol=https\nhost=fixture.invalid\n\n',
  })
  expect(helper.code).not.toBe(0)
  // The fake helper is intentionally invalid, proving Git found and executed it.
  expect(helper.stderr).toContain('invalid credential line: fixture-helper')
  const restarted = new Tools(f.root, execute, async () => {}, f.fetch, false, f.recipe)
  disposals.push(() => restarted.close())
  expect(await restarted.setup()).toBe(paths[0]); expect(f.fetch).toHaveBeenCalledTimes(1)
  await writeFile(paths[0]!, 'modified')
  const corrupt = new Tools(f.root, execute, async () => {}, f.fetch, false, f.recipe)
  disposals.push(() => corrupt.close())
  await expect(corrupt.setup()).rejects.toMatchObject({ code: 'toolIntegrity' })
})
it('cleans an interrupted install, preserves foreign directories, and retries offline failures explicitly', async () => {
  let abortEntered!: () => void
  const entered = new Promise<void>(resolve => { abortEntered = resolve })
  const f = await fixture(async (_url, signal) => {
    abortEntered()
    return new Promise<Buffer>((_resolve, reject) => signal.addEventListener('abort', () => reject(new WorkspaceError('stopped')), { once: true }))
  })
  const pending = f.tools.setup()
  await entered; await f.tools.close()
  await expect(pending).rejects.toMatchObject({ code: 'stopped' })
  expect(await readdir(f.root)).toEqual([])
  let attempts = 0
  const downloader = vi.fn(async () => { if (++attempts === 1) throw new Error('private-error-never-returned'); return f.archive })
  const retry = new Tools(f.root, execute, async () => {}, downloader, false, f.recipe)
  disposals.push(() => retry.close())
  await expect(retry.setup()).rejects.toMatchObject({ code: 'toolDownload' })
  await expect(retry.setup()).rejects.toMatchObject({ code: 'toolDownload' })
  expect(downloader).toHaveBeenCalledTimes(1)
  await retry.setup(true)
  expect(downloader).toHaveBeenCalledTimes(2)
  expect(retry.state().status).toBe('ready')
  expect(await lstat(join(f.root, '.install.lock')).catch(() => null)).toBeNull()
  expect((await readFile(await retry.setup())).equals(script)).toBe(true)
})
it('reuses system gh without installing and preserves an unowned generation directory', async () => {
  const f = await fixture(), prepare = vi.fn(async () => {})
  const run = vi.fn(async () => ({ code: 0, stdout: 'gh version ' + GH_VERSION + ' (fixture)', stderr: '' }))
  const system = new Tools(f.root, run, prepare, f.fetch)
  disposals.push(() => system.close())
  expect(await system.setup()).toBe('gh')
  expect(system.state()).toMatchObject({ status: 'ready', source: 'system' })
  expect(prepare).not.toHaveBeenCalled(); expect(f.fetch).not.toHaveBeenCalled()
  const unowned = join(f.root, 'gh-' + GH_VERSION + '-' + process.platform + '-' + process.arch)
  await mkdir(unowned); await writeFile(join(unowned, 'keep'), 'foreign')
  await expect(f.tools.setup()).rejects.toMatchObject({ code: 'unsafeDirectory' })
  expect(await readFile(join(unowned, 'keep'), 'utf8')).toBe('foreign')
})
it('does not remove another installer lock and can reuse the result after it completes', async () => {
  let enter!: () => void, finish!: () => void
  const entered = new Promise<void>(resolve => { enter = resolve }), released = new Promise<void>(resolve => { finish = resolve })
  const f = await fixture(async () => { enter(); await released; return f.archive })
  const first = f.tools.setup()
  await entered
  const other = new Tools(f.root, execute, async () => {}, f.fetch, false, f.recipe)
  disposals.push(() => other.close())
  await expect(other.setup()).rejects.toMatchObject({ code: 'busy' })
  expect(JSON.parse(await readFile(join(f.root, '.install.lock'), 'utf8')).owner).toBe('dsh-github-tools/v1')
  finish()
  const path = await first
  expect(await other.setup(true)).toBe(path)
})
