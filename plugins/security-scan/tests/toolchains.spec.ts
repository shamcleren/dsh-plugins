import { createHash } from 'node:crypto'
import { gzipSync } from 'node:zlib'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { releaseBinary, Toolchains, waitForSetup } from '../src/toolchains.js'
const roots: string[] = []
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })
const root = async () => { const path = await mkdtemp(join(tmpdir(), 'security-toolchains-')); roots.push(path); return path }
function archive(type = '0') {
  const header = Buffer.alloc(512)
  header.write('trusted/tool'); header.write('00000000004', 124); header.write(type, 156)
  const data = gzipSync(Buffer.concat([header, Buffer.from('safe'), Buffer.alloc(508 + 1024)]))
  return { data, hash: createHash('sha256').update(data).digest('hex') }
}
it('checks integrity before extracting only the named regular binary, rejecting links and unknown entries', () => {
  const { data, hash } = archive()
  expect(releaseBinary(data, hash, 'trusted/tool').toString()).toBe('safe')
  expect(() => releaseBinary(data, '0'.repeat(64), 'trusted/tool')).toThrow('toolchain-integrity')
  expect(() => releaseBinary(data, hash, '../tool')).toThrow('toolchain-archive')
  const link = archive('2')
  expect(() => releaseBinary(link.data, link.hash, 'trusted/tool')).toThrow('toolchain-archive')
})
it('keeps a concurrent install lock and existing data intact without downloading', async () => {
  const path = await root(), lock = join(path, '.install.lock')
  await writeFile(lock, 'another owner')
  const fetcher = vi.spyOn(globalThis, 'fetch')
  const manager = new Toolchains(path)
  await expect(manager.setup()).rejects.toThrow('toolchain-locked')
  expect(manager.state()).toMatchObject({ status: 'failed', error: 'toolchain-locked' })
  expect(await readFile(lock, 'utf8')).toBe('another owner')
  expect(fetcher).not.toHaveBeenCalled(); await manager.close()
})
it('deduplicates setup, cleans its failed generation, and allows a retry without touching unknown directories', async () => {
  const path = await root(); await mkdir(join(path, 'keep')); await writeFile(join(path, 'keep/data'), 'user')
  const fetcher = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('bad', { status: 503 }))
  const manager = new Toolchains(path), first = manager.setup(), second = manager.setup()
  expect(first).toBe(second)
  await expect(first).rejects.toThrow('toolchain-download')
  expect(fetcher).toHaveBeenCalledOnce()
  await expect(readFile(join(path, '.install.lock'))).rejects.toMatchObject({ code: 'ENOENT' })
  await expect(manager.setup()).rejects.toThrow('toolchain-download')
  expect(fetcher).toHaveBeenCalledTimes(2); expect(await readFile(join(path, 'keep/data'), 'utf8')).toBe('user')
  await manager.close()
})
it('does not set up unused or custom engines, and waiter cancellation leaves shared setup intact', async () => {
  const manager = new Toolchains(await root()), setup = vi.spyOn(manager, 'setup')
  await expect(manager.resolve('/custom/semgrep', '/custom/gitleaks', new AbortController().signal, { semgrep: true, gitleaks: true })).resolves.toEqual({ semgrepPath: '/custom/semgrep', gitleaksPath: '/custom/gitleaks' })
  await manager.resolve(undefined, undefined, new AbortController().signal, { semgrep: false, gitleaks: false })
  expect(setup).not.toHaveBeenCalled()
  let complete!: (value: string) => void
  const shared = new Promise<string>(resolve => { complete = resolve }), abort = new AbortController()
  const waiting = waitForSetup(shared, abort.signal); abort.abort()
  await expect(waiting).rejects.toThrow('cancelled'); complete('ready'); await expect(shared).resolves.toBe('ready')
  await manager.close(); await expect(manager.setup()).rejects.toThrow('service-stopped')
})
