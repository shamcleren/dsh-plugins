import { createHash, randomUUID } from 'node:crypto'
import { gunzipSync } from 'node:zlib'
import { lstat, mkdir, open, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { z } from 'zod'
import { runScanner } from './process.js'
import type { ToolchainState } from './ui-contract.js'

const UV_VERSION = '0.8.22', PYTHON_VERSION = '3.13.7'
const SEMGREP_VERSION = '1.176.1', GITLEAKS_VERSION = '8.24.2'
const assets: Record<string, { target: string; uv: string; gitleaks: string; suffix: string }> = {
  'darwin-arm64': { target: 'aarch64-apple-darwin', uv: '3f61099e261e449527141dbf125629fab33ad696468c8c90cebbac40185a306c', suffix: 'darwin_arm64', gitleaks: '90d13686937ac7429b97a3acbf1e1d0ce90d92ae2d0cf46a690bd8ae5230bea0' },
  'darwin-x64': { target: 'x86_64-apple-darwin', uv: '76638fdcfa91357858771551a1c88de1f7c3b270b33ab1866f8a0618d9e442d8', suffix: 'darwin_x64', gitleaks: 'bc3c46f8039ba716ba8461fa6745c9d1cfb90ca2f5f881d8d0cf66b7ba7b742c' },
  'linux-arm64': { target: 'aarch64-unknown-linux-gnu', uv: '726b72a137fda33565143325f7d31c42cd30ff9ccdf067e00d124d37b4081cb2', suffix: 'linux_arm64', gitleaks: '574a6d52573c61173add7ddb5e3cc68c0e82cb0735818a1eeb9a0a2de1643fbc' },
  'linux-x64': { target: 'x86_64-unknown-linux-gnu', uv: '741ff1f5742c5a4a25d2f829e8395355e43f7a5ae2ebc6368e9ae2df0efb69cf', suffix: 'linux_x64', gitleaks: 'fa0500f6b7e41d28791ebc680f5dd9899cd42b58629218a5f041efa899151a8e' },
}
const owner = 'dsh-security-toolchains-v1'
const ReadySchema = z.object({ owner: z.literal(owner), recipe: z.string().regex(/^[a-f0-9]{64}$/u), generation: z.string().uuid() }).strict()
type Paths = { semgrepPath: string; gitleaksPath: string }
const digest = (data: Buffer | string): string => createHash('sha256').update(data).digest('hex')
export const defaultToolchainRoot = (): string => resolve(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'security-scan/toolchains')
export const managedPath = (path: string | undefined, engine: 'semgrep' | 'gitleaks'): boolean => !path || path === engine

/** Extract exactly one regular entry from an integrity-verified release, never archive paths. */
export function releaseBinary(archive: Buffer, expectedHash: string, entry: string): Buffer {
  if (digest(archive) !== expectedHash) throw new Error('toolchain-integrity')
  const tar = gunzipSync(archive, { maxOutputLength: 256 * 1024 * 1024 })
  for (let offset = 0; offset + 512 <= tar.length;) {
    const header = tar.subarray(offset, offset + 512)
    const text = (start: number, end: number): string => header.subarray(start, end).toString('utf8').replace(/\0.*$/su, '')
    const prefix = text(345, 500), name = (prefix ? prefix + '/' : '') + text(0, 100)
    const size = Number.parseInt(text(124, 136).trim(), 8)
    if (!name) break
    if (!Number.isSafeInteger(size) || size < 0 || offset + 512 + size > tar.length) throw new Error('toolchain-archive')
    if (name === entry) {
      if (!['0', ''].includes(text(156, 157)) || !size) throw new Error('toolchain-archive')
      return tar.subarray(offset + 512, offset + 512 + size)
    }
    offset += 512 + Math.ceil(size / 512) * 512
  }
  throw new Error('toolchain-archive')
}
async function download(url: string, signal: AbortSignal): Promise<Buffer> {
  const response = await fetch(url, { signal: AbortSignal.any([signal, AbortSignal.timeout(180_000)]) })
  if (!response.ok || !response.body) throw new Error('toolchain-download')
  const chunks: Uint8Array[] = []; let size = 0
  for await (const chunk of response.body) {
    size += chunk.length
    if (size > 64 * 1024 * 1024) throw new Error('toolchain-download')
    chunks.push(chunk)
  }
  return Buffer.concat(chunks)
}
async function directory(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 })
  const stat = await lstat(path)
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('toolchain-storage')
}
async function regular(path: string): Promise<void> {
  const stat = await lstat(path)
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 4096) throw new Error('toolchain-storage')
}
/** Waiters may cancel their scan without cancelling shared setup owned by the plugin lifetime. */
export async function waitForSetup<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted()
  return new Promise((resolve, reject) => {
    const abort = (): void => reject(new Error('Security scan cancelled'))
    signal.addEventListener('abort', abort, { once: true })
    void promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort))
  })
}
export class Toolchains {
  private stateValue: ToolchainState = { status: 'idle', phase: 'idle', semgrep: SEMGREP_VERSION, gitleaks: GITLEAKS_VERSION, error: '' }
  private pending: Promise<Paths> | undefined
  private paths: Paths | undefined
  private readonly controller = new AbortController()
  constructor(readonly root = defaultToolchainRoot()) {}
  state(): ToolchainState { return { ...this.stateValue } }
  private phase(phase: ToolchainState['phase']): void { this.stateValue = { ...this.stateValue, status: 'installing', phase, error: '' } }
  setup(): Promise<Paths> {
    if (this.controller.signal.aborted) return Promise.reject(new Error('service-stopped'))
    if (this.paths) return Promise.resolve(this.paths)
    if (this.pending) return this.pending
    this.phase('checking')
    this.pending = this.install().then(paths => { this.paths = paths; this.stateValue = { ...this.stateValue, status: 'ready', phase: 'ready', error: '' }; return paths }).catch(error => {
      const code = error instanceof Error && /^toolchain-(?:integrity|storage|locked|unsupported|download|python|semgrep|gitleaks|archive)$/u.test(error.message) ? error.message : 'toolchain-failed'
      this.stateValue = { ...this.stateValue, status: 'failed', error: code }; throw new Error(code)
    }).finally(() => { this.pending = undefined })
    return this.pending
  }
  async resolve(semgrepPath: string | undefined, gitleaksPath: string | undefined, signal: AbortSignal, needs: { semgrep: boolean; gitleaks: boolean }): Promise<Paths> {
    const useSemgrep = needs.semgrep && managedPath(semgrepPath, 'semgrep'), useGitleaks = needs.gitleaks && managedPath(gitleaksPath, 'gitleaks')
    const defaults = useSemgrep || useGitleaks ? await waitForSetup(this.setup(), signal) : undefined
    return { semgrepPath: useSemgrep ? defaults!.semgrepPath : semgrepPath ?? 'semgrep', gitleaksPath: useGitleaks ? defaults!.gitleaksPath : gitleaksPath ?? 'gitleaks' }
  }
  async close(): Promise<void> { this.controller.abort(); await this.pending?.catch(() => {}) }
  private async install(): Promise<Paths> {
    const platform = process.platform + '-' + process.arch, asset = assets[platform]
    if (!asset) throw new Error('toolchain-unsupported')
    const signal = AbortSignal.any([this.controller.signal, AbortSignal.timeout(15 * 60_000)])
    const lockfile = fileURLToPath(new URL('../toolchains/requirements.lock', import.meta.url))
    const recipe = digest(JSON.stringify({ asset, UV_VERSION, PYTHON_VERSION, SEMGREP_VERSION, GITLEAKS_VERSION }) + await readFile(lockfile, 'utf8'))
    await directory(this.root)
    const root = await realpath(this.root)
    const pathsFor = (generation: string): Paths => ({ semgrepPath: join(root, generation, 'venv/bin/semgrep'), gitleaksPath: join(root, generation, 'gitleaks') })
    const environment = (cwd: string): Record<string, string> => ({ PATH: '/usr/bin:/bin', HOME: cwd, TMPDIR: cwd, UV_NO_CONFIG: '1', UV_PYTHON_INSTALL_DIR: join(cwd, 'python'), UV_CACHE_DIR: join(cwd, 'cache'), UV_PYTHON_BIN_DIR: join(cwd, 'bin'), UV_NO_PROGRESS: '1', UV_KEYRING_PROVIDER: 'disabled', UV_DEFAULT_INDEX: 'https://pypi.org/simple', PYTHONNOUSERSITE: '1', SEMGREP_SEND_METRICS: 'off', SEMGREP_ENABLE_VERSION_CHECK: '0', SEMGREP_SETTINGS_FILE: join(cwd, 'settings.yml'), OTEL_SDK_DISABLED: 'true' })
    const command = async (binary: string, args: string[], cwd: string, phase: 'python' | 'semgrep' | 'gitleaks'): Promise<string> => {
      const result = await runScanner(binary, args, cwd, signal, environment(cwd), 600_000)
      if (result.code !== 0) throw new Error('toolchain-' + phase)
      return result.stdout.trim()
    }
    const verify = async (paths: Paths, cwd: string): Promise<void> => {
      if (await command(paths.semgrepPath, ['--version'], cwd, 'semgrep') !== SEMGREP_VERSION) throw new Error('toolchain-semgrep')
      if (await command(paths.gitleaksPath, ['version'], cwd, 'gitleaks') !== GITLEAKS_VERSION) throw new Error('toolchain-gitleaks')
    }
    const ready = join(root, 'ready.json')
    try {
      await regular(ready)
      const record = ReadySchema.parse(JSON.parse(await readFile(ready, 'utf8')))
      if (record.recipe === recipe) {
        const cwd = join(root, record.generation)
        const stat = await lstat(cwd)
        if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('toolchain-storage')
        const paths = pathsFor(record.generation); await verify(paths, cwd); return paths
      }
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
    const lockPath = join(root, '.install.lock')
    const lock = await open(lockPath, 'wx', 0o600).catch(() => { throw new Error('toolchain-locked') })
    const generation = randomUUID(), cwd = join(root, generation), next = join(root, '.' + generation + '.json')
    let complete = false, created = false
    try {
      await lock.writeFile(JSON.stringify({ owner, pid: process.pid, generation }))
      await mkdir(cwd, { mode: 0o700 }); created = true
      const uv = join(cwd, 'uv')
      this.phase('download')
      await writeFile(uv, releaseBinary(await download('https://github.com/astral-sh/uv/releases/download/' + UV_VERSION + '/uv-' + asset.target + '.tar.gz', signal), asset.uv, 'uv-' + asset.target + '/uv'), { flag: 'wx', mode: 0o700 })
      this.phase('python')
      await command(uv, ['venv', '--no-project', '--managed-python', '--python', PYTHON_VERSION, join(cwd, 'venv')], cwd, 'python')
      this.phase('semgrep')
      await command(uv, ['pip', 'install', '--python', join(cwd, 'venv/bin/python'), '--require-hashes', '--only-binary=:all:', '--no-deps', '--link-mode', 'copy', '-r', lockfile], cwd, 'semgrep')
      this.phase('gitleaks')
      await writeFile(pathsFor(generation).gitleaksPath, releaseBinary(await download('https://github.com/gitleaks/gitleaks/releases/download/v' + GITLEAKS_VERSION + '/gitleaks_' + GITLEAKS_VERSION + '_' + asset.suffix + '.tar.gz', signal), asset.gitleaks, 'gitleaks'), { flag: 'wx', mode: 0o700 })
      this.phase('checking'); await verify(pathsFor(generation), cwd)
      signal.throwIfAborted()
      await writeFile(next, JSON.stringify({ owner, recipe, generation }), { flag: 'wx', mode: 0o600 })
      await rename(next, ready); complete = true
      return pathsFor(generation)
    } finally {
      await rm(next, { force: true })
      if (!complete && created) await rm(cwd, { recursive: true, force: true })
      const held = await lock.stat(), current = await lstat(lockPath).catch(() => undefined)
      if (current && current.dev === held.dev && current.ino === held.ino) await rm(lockPath)
      await lock.close()
    }
  }
}
