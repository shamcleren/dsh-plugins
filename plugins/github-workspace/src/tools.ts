import { createHash, randomUUID } from 'node:crypto'
import { lstat, mkdir, open, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises'
import { delimiter, dirname, join } from 'node:path'
import { gunzipSync, inflateRawSync } from 'node:zlib'
import { commandEnvironment, type CommandOptions, type Execute } from './process.js'
import { WorkspaceError, type ToolsState } from './types.js'

export const GH_VERSION = '2.103.3'
const assets: Record<string, { suffix: string; hash: string }> = {
  'darwin-arm64': { suffix: 'macOS_arm64.zip', hash: 'd700207eae9ae98fe2b89535c2c087c07823d4628c56364695a5a07ef311c062' },
  'darwin-x64': { suffix: 'macOS_amd64.zip', hash: 'a2f86418f4350ae6e9ec60d5000bdf7665728436946a97fc27fe50e6ae752682' },
  'linux-arm64': { suffix: 'linux_arm64.tar.gz', hash: 'ee32df2323c8847f5fac6cb6b4b69ca75828e9329a8f22f677021f7b3306ce63' },
  'linux-x64': { suffix: 'linux_amd64.tar.gz', hash: '4c806978ffce1cec70853302a56d70ac6da4f19bae7adca4e1a8ab00633dd91d' },
}
const digest = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex')
const owner = 'dsh-github-tools/v1'

/** Read one known regular executable from a verified archive, never extract paths. */
export function releaseBinary(bytes: Buffer, hash: string, entry: string, zip: boolean): Buffer {
  if (digest(bytes) !== hash) throw new WorkspaceError('toolIntegrity')
  try {
    if (zip) {
      let end = bytes.length - 22
      while (end >= Math.max(0, bytes.length - 65557) && bytes.readUInt32LE(end) !== 0x06054b50) end--
      if (end < 0 || bytes.readUInt32LE(end) !== 0x06054b50 || bytes.readUInt16LE(end + 4) || bytes.readUInt16LE(end + 6)) throw new Error()
      let offset = bytes.readUInt32LE(end + 16)
      for (let count = bytes.readUInt16LE(end + 10); count > 0; count--) {
        if (bytes.readUInt32LE(offset) !== 0x02014b50) throw new Error()
        const size = bytes.readUInt32LE(offset + 20), expanded = bytes.readUInt32LE(offset + 24)
        const length = bytes.readUInt16LE(offset + 28), extra = bytes.readUInt16LE(offset + 30), comment = bytes.readUInt16LE(offset + 32)
        const name = bytes.subarray(offset + 46, offset + 46 + length).toString('utf8')
        if (name === entry) {
          const type = bytes.readUInt32LE(offset + 38) >>> 16 & 0xf000, method = bytes.readUInt16LE(offset + 10)
          if ((bytes.readUInt16LE(offset + 8) & 1) || ![0, 0x8000].includes(type) || !expanded || expanded > 128 * 1024 * 1024) throw new Error()
          const local = bytes.readUInt32LE(offset + 42)
          if (bytes.readUInt32LE(local) !== 0x04034b50) throw new Error()
          const start = local + 30 + bytes.readUInt16LE(local + 26) + bytes.readUInt16LE(local + 28)
          if (start + size > offset) throw new Error()
          const data = bytes.subarray(start, start + size)
          const result = method === 8 ? inflateRawSync(data, { maxOutputLength: 128 * 1024 * 1024 }) : method === 0 ? data : undefined
          if (!result || result.length !== expanded) throw new Error()
          return result
        }
        offset += 46 + length + extra + comment
      }
    } else {
      const tar = gunzipSync(bytes, { maxOutputLength: 256 * 1024 * 1024 })
      for (let offset = 0; offset + 512 <= tar.length;) {
        const header = tar.subarray(offset, offset + 512)
        const text = (start: number, end: number) => header.subarray(start, end).toString('utf8').replace(/\0.*$/su, '')
        const prefix = text(345, 500), name = (prefix ? prefix + '/' : '') + text(0, 100)
        if (!name) break
        const size = Number.parseInt(text(124, 136).trim(), 8)
        if (!Number.isSafeInteger(size) || size < 0 || offset + 512 + size > tar.length) throw new Error()
        if (name === entry) {
          if (!['0', ''].includes(text(156, 157)) || !size) throw new Error()
          return tar.subarray(offset + 512, offset + 512 + size)
        }
        offset += 512 + Math.ceil(size / 512) * 512
      }
    }
  } catch { throw new WorkspaceError('toolIntegrity') }
  throw new WorkspaceError('toolIntegrity')
}

export async function downloadRelease(url: string, signal: AbortSignal, progress: (value: number) => void): Promise<Buffer> {
  const deadline = AbortSignal.any([signal, AbortSignal.timeout(180_000)])
  for (let redirects = 0; redirects < 5; redirects++) {
    const target = new URL(url)
    if (target.protocol !== 'https:' || target.port || target.username || target.password ||
      !['github.com', 'release-assets.githubusercontent.com', 'objects.githubusercontent.com'].includes(target.hostname)) throw new WorkspaceError('toolDownload')
    const response = await fetch(url, { signal: deadline, redirect: 'manual' })
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      await response.body?.cancel()
      const location = response.headers.get('location')
      if (!location) throw new WorkspaceError('toolDownload')
      url = new URL(location, url).href
      continue
    }
    if (!response.ok || !response.body) { await response.body?.cancel(); throw new WorkspaceError('toolDownload') }
    const total = Number(response.headers.get('content-length')), chunks: Uint8Array[] = []
    let size = 0
    for await (const chunk of response.body) {
      size += chunk.length
      if (size > 64 * 1024 * 1024) throw new WorkspaceError('toolDownload')
      chunks.push(chunk)
      if (total > 0) progress(Math.min(100, Math.floor(size / total * 100)))
    }
    return Buffer.concat(chunks)
  }
  throw new WorkspaceError('toolDownload')
}

export class Tools {
  private value: ToolsState = { status: 'checking' }
  private pending: Promise<string> | undefined
  private binary: string | undefined
  private readonly controller = new AbortController()
  constructor(private root: string, private readonly execute: Execute, private readonly prepare: () => Promise<void>,
    private readonly download = downloadRelease, private readonly system = true, private readonly release = assets[process.platform + '-' + process.arch]) {}
  state(): ToolsState { return { ...this.value } }
  environment(): NodeJS.ProcessEnv {
    const env = commandEnvironment()
    if (this.binary && this.binary !== 'gh') env.PATH = dirname(this.binary) + delimiter + (env.PATH ?? '')
    return env
  }
  start(retry = false): ToolsState { void this.setup(retry).catch(() => {}); return this.state() }
  async close(): Promise<void> { this.controller.abort(); await this.pending?.catch(() => {}) }
  async run(command: string, args: string[], options: CommandOptions = {}) {
    let binary = command
    if (command === 'gh' || (command === 'git' && args.some(arg => ['clone', 'fetch', 'push', 'ls-remote'].includes(arg)))) {
      const setup = this.setup()
      // A request may leave while the plugin-owned download continues.
      binary = await new Promise<string>((resolve, reject) => {
        const abort = () => reject(new WorkspaceError('stopped'))
        if (options.signal?.aborted) { abort(); return }
        options.signal?.addEventListener('abort', abort, { once: true })
        void setup.then(resolve, reject).finally(() => options.signal?.removeEventListener('abort', abort))
      }).then(path => command === 'gh' ? path : command)
    }
    return this.execute(binary, args, { ...options, env: { ...this.environment(), ...options.env, PATH: this.environment().PATH } })
  }
  setup(retry = false): Promise<string> {
    if (this.controller.signal.aborted) return Promise.reject(new WorkspaceError('stopped'))
    if (this.binary) return Promise.resolve(this.binary)
    if (this.pending) return this.pending
    if (this.value.status === 'failed' && !retry) return Promise.reject(new WorkspaceError(this.value.error ?? 'toolDownload'))
    this.value = { status: 'checking' }
    this.pending = this.install().then(binary => {
      this.binary = binary; this.value = { status: 'ready', source: binary === 'gh' || !binary.startsWith(this.root + '/') ? 'system' : 'managed' }
      return binary
    }).catch(error => {
      const failure = error instanceof WorkspaceError ? error : new WorkspaceError('toolDownload')
      this.value = { status: 'failed', error: failure.code }; throw failure
    }).finally(() => { this.pending = undefined })
    return this.pending
  }
  private async valid(binary: string, exact = false): Promise<boolean> {
    try {
      const result = await this.execute(binary, ['--version'], { env: commandEnvironment(), signal: this.controller.signal, timeoutMs: 10_000 })
      return result.code === 0 && (exact ? result.stdout.startsWith('gh version ' + GH_VERSION + ' ') : /^gh version 2\./u.test(result.stdout))
    } catch { return false }
  }
  private async install(): Promise<string> {
    const signal = this.controller.signal
    if (this.system) for (const path of ['gh', '/opt/homebrew/bin/gh', '/usr/local/bin/gh']) if (await this.valid(path)) return path
    signal.throwIfAborted()
    const asset = this.release
    if (!asset) throw new WorkspaceError('toolUnsupported')
    await this.prepare()
    await mkdir(this.root, { recursive: true, mode: 0o700 })
    const info = await lstat(this.root)
    if (!info.isDirectory() || info.isSymbolicLink()) throw new WorkspaceError('unsafeDirectory')
    this.root = await realpath(this.root)
    const target = join(this.root, 'gh-' + GH_VERSION + '-' + process.platform + '-' + process.arch), binary = join(target, 'gh')
    try {
      const dir = await lstat(target), marker = await lstat(join(target, 'ready.json')), file = await lstat(binary)
      if (!dir.isDirectory() || dir.isSymbolicLink() || !marker.isFile() || marker.isSymbolicLink() || marker.size > 1024 ||
        !file.isFile() || file.isSymbolicLink() || file.size > 128 * 1024 * 1024) throw new WorkspaceError('unsafeDirectory')
      const record = JSON.parse(await readFile(join(target, 'ready.json'), 'utf8')) as Record<string, unknown>
      if (record.owner !== owner || record.archive !== asset.hash || record.binary !== digest(await readFile(binary))) throw new WorkspaceError('toolIntegrity')
      if (!await this.valid(binary, true)) throw new WorkspaceError('toolIntegrity')
      return binary
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      try { await lstat(target); throw new WorkspaceError('unsafeDirectory') } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
    }
    const lockPath = join(this.root, '.install.lock')
    const lock = await open(lockPath, 'wx', 0o600).catch(() => { throw new WorkspaceError('busy') })
    const stage = join(this.root, '.install-' + randomUUID())
    let created = false
    try {
      await lock.writeFile(JSON.stringify({ owner, pid: process.pid, version: GH_VERSION }))
      await mkdir(stage, { mode: 0o700 }); created = true
      this.value = { status: 'downloading', progress: 0 }
      const name = 'gh_' + GH_VERSION + '_' + asset.suffix
      const archive = await this.download('https://github.com/cli/cli/releases/download/v' + GH_VERSION + '/' + name, signal,
        progress => { this.value = { status: 'downloading', progress } })
      signal.throwIfAborted(); this.value = { status: 'verifying' }
      const content = releaseBinary(archive, asset.hash, name.replace(/\.(?:zip|tar\.gz)$/u, '') + '/bin/gh', name.endsWith('.zip'))
      await writeFile(join(stage, 'gh'), content, { flag: 'wx', mode: 0o700 })
      if (!await this.valid(join(stage, 'gh'), true)) throw new WorkspaceError('toolIntegrity')
      await writeFile(join(stage, 'ready.json'), JSON.stringify({ owner, archive: asset.hash, binary: digest(content) }), { flag: 'wx', mode: 0o600 })
      signal.throwIfAborted()
      await rename(stage, target)
      return binary
    } finally {
      if (created) await rm(stage, { recursive: true, force: true })
      await lock.close(); await rm(lockPath)
    }
  }
}
