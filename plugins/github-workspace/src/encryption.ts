import { constants } from 'node:fs'
import { lstat, mkdtemp, open, realpath, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { delimiter, dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { z } from 'zod'
import type { CommandOptions, Execute, Result } from './process.js'
import { WorkspaceError, type Encryption, type Project } from './types.js'

const localPath = z.string().trim().min(1).max(4096).refine(path => !/[\u0000-\u001f]/u.test(path) && (isAbsolute(path) || path.startsWith('~/')))
export const encryptionSchema = z.discriminatedUnion('keySource', [
  z.strictObject({ mode: z.literal('git-crypt'), keySource: z.literal('file'), keyFile: localPath, binaryPath: localPath.optional() }),
  z.strictObject({ mode: z.literal('git-crypt'), keySource: z.literal('gpg'), binaryPath: localPath.optional() }),
]).transform(({ binaryPath, ...rest }): Encryption => ({ ...rest, ...(binaryPath === undefined ? {} : { binaryPath }) }))
type Command = (args: string[], options?: CommandOptions) => Promise<Result>
const magic = Buffer.from('\0GITCRYPT\0')
const expand = (path: string) => resolve(path.startsWith('~/') ? join(homedir(), path.slice(2)) : path)
const quote = (path: string) => "'" + path.replace(/'/gu, "'\\''") + "'"
const filters = (binary: string): Record<string, string> => ({
  'filter.git-crypt.clean': quote(binary) + ' clean', 'filter.git-crypt.smudge': quote(binary) + ' smudge',
  'filter.git-crypt.required': 'true',
})

export class EncryptionSupport {
  private readonly binaries = new Map<string, string>()
  private readonly bindings = new Map<string, string>()
  private readonly verified = new Map<string, string>()
  constructor(private readonly run: Execute, private readonly options: () => CommandOptions, private readonly scratch: string, private readonly hooks: string) {}
  arguments(cwd: string): string[] {
    const binary = this.bindings.get(cwd)
    return Object.entries(binary ? filters(binary) : { 'filter.git-crypt.required': 'true' }).flatMap(([key, value]) => ['-c', key + '=' + value])
  }
  private async checked(command: Command, args: string[], extra?: CommandOptions): Promise<string> {
    const result = await command(args, extra)
    if (result.code !== 0) throw new WorkspaceError('encryptionUnsafe')
    return result.stdout
  }
  private async protected(command: Command, paths: string[], env?: NodeJS.ProcessEnv): Promise<Set<string>> {
    const protectedPaths = new Set<string>()
    if (paths.length) {
      const records = (await this.checked(command, ['check-attr', '--cached', '-z', '--stdin', 'filter'], {
        ...(env ? { env } : {}), input: paths.join('\0') + '\0', maxBytes: 16 * 1024 * 1024,
      })).split('\0')
      for (let i = 0; i + 2 < records.length; i += 3) {
        const filter = records[i + 2]!
        if (filter.startsWith('git-crypt-')) throw new WorkspaceError('encryptionUnsafe')
        if (filter === 'git-crypt') protectedPaths.add(records[i]!)
      }
    }
    return protectedPaths
  }
  private async required(project: Project, command: Command): Promise<boolean> {
    const paths = (await this.checked(command, ['ls-files', '-z', '--cached', '--others', '--exclude-standard'])).split('\0').filter(Boolean)
    if ((await this.protected(command, paths)).size) return true
    // Newly edited/untracked attributes also require setup before they can be staged.
    const attributes = paths.filter(path => path === '.gitattributes' || path.endsWith('/.gitattributes'))
    for (const path of attributes) {
      const file = await open(join(project.path, path), constants.O_RDONLY | constants.O_NOFOLLOW).catch(error => { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error })
      if (!file) continue
      try {
        const info = await file.stat()
        if (!info.isFile() || info.size > 128 * 1024) throw new WorkspaceError('encryptionUnsafe')
        if ((await file.readFile('utf8')).split('\n').some(line => !/^\s*#/u.test(line) && /\bfilter\s*=\s*git-crypt(?:\s|$)/u.test(line))) return true
      } finally { await file.close() }
    }
    try { await lstat(join(project.path, '.git/git-crypt')); throw new WorkspaceError('encryptionUnsafe') }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
    if (project.encryption) throw new WorkspaceError('encryptionUnsafe')
    return false
  }
  private async binary(config: Encryption): Promise<string> {
    const key = config.binaryPath ?? ''
    const cached = this.binaries.get(key)
    if (cached) {
      try { const info = await lstat(cached); if (info.isFile() && (info.mode & 0o111)) return cached }
      catch { /* A package-manager upgrade may remove the previous resolved binary. */ }
      this.binaries.delete(key)
    }
    const candidates = config.binaryPath ? [expand(config.binaryPath)] : [
      ...(this.options().env?.PATH ?? '').split(delimiter).filter(isAbsolute).map(path => join(path, 'git-crypt')),
      '/opt/homebrew/bin/git-crypt', '/usr/local/bin/git-crypt',
    ]
    for (const candidate of candidates) try {
      const path = await realpath(candidate), info = await lstat(path)
      if (!info.isFile() || !(info.mode & 0o111)) continue
      const result = await this.run(path, ['--version'], { ...this.options(), timeoutMs: 10_000 })
      if (result.code === 0 && /^git-crypt 0\.(?:7|8)\./u.test(result.stdout + result.stderr)) {
        this.binaries.set(key, path); return path
      }
    } catch { /* Try the remaining local executables without returning their output. */ }
    throw new WorkspaceError('cryptMissing')
  }
  private async internalKey(project: Project): Promise<boolean> {
    try {
      for (const path of ['.git/git-crypt', '.git/git-crypt/keys']) {
        const info = await lstat(join(project.path, path))
        if (!info.isDirectory() || info.isSymbolicLink()) throw new WorkspaceError('encryptionUnsafe')
      }
      const key = await lstat(join(project.path, '.git/git-crypt/keys/default'))
      if (!key.isFile() || key.isSymbolicLink() || key.size > 16384 || (key.mode & 0o077)) throw new WorkspaceError('encryptionKey')
      return true
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; return false }
  }
  async ready(project: Project, command: Command): Promise<boolean> {
    if (!await this.required(project, command)) return false
    if (!project.encryption || !await this.internalKey(project)) throw new WorkspaceError('encryptionRequired')
    if ((await command(['config', '--get-all', 'filter.git-crypt.process'])).code !== 1) throw new WorkspaceError('encryptionUnsafe')
    const binary = await this.binary(project.encryption), keyFile = join(project.path, '.git/git-crypt/keys/default')
    const info = await lstat(keyFile), head = await command(['rev-parse', '--verify', '--quiet', 'HEAD'])
    const fingerprint = [head.stdout, info.ino, info.mtimeMs, info.ctimeMs, info.size].join(':')
    if (this.verified.get(project.path) !== fingerprint) {
      await this.sample(project, command, binary, keyFile)
      this.verified.set(project.path, fingerprint)
    }
    this.bindings.set(project.path, binary)
    return true
  }
  private async sample(project: Project, command: Command, binary: string, keyFile: string): Promise<void> {
    const head = await command(['rev-parse', '--verify', '--quiet', 'HEAD'])
    if (head.code !== 0) return
    const temporary = await mkdtemp(join(this.scratch, 'crypt-key-'))
    try {
      const env = { ...this.options().env, GIT_INDEX_FILE: join(temporary, 'index') }
      await this.checked(command, ['read-tree', 'HEAD'], { env })
      const paths = (await this.checked(command, ['ls-tree', '-r', '--name-only', '-z', 'HEAD'])).split('\0').filter(Boolean)
      const protectedPaths = await this.protected(command, paths, env)
      if (!protectedPaths.size) return
      const path = protectedPaths.values().next().value!
      const blob = await command(['cat-file', 'blob', 'HEAD:' + path], { captureBinary: true, maxBytes: 64 * 1024 * 1024 })
      if (blob.code !== 0 || !blob.stdoutBytes?.subarray(0, 10).equals(magic)) throw new WorkspaceError('encryptionUnsafe')
      const cipher = join(temporary, 'cipher')
      await writeFile(cipher, blob.stdoutBytes, { mode: 0o600, flag: 'wx' })
      const result = await this.run(binary, ['diff', '--key-file=' + keyFile, cipher], { ...this.options(), cwd: project.path, stdoutLimit: 0, maxBytes: 64 * 1024 * 1024 })
      if (result.code !== 0) throw new WorkspaceError('encryptionKey')
    } finally { await rm(temporary, { recursive: true, force: true }) }
  }
  async unlock(project: Project, command: Command): Promise<void> {
    if (!await this.required(project, command)) return
    // Persist a required driver even on setup failure: ordinary Git must also fail closed.
    await this.checked(command, ['config', '--local', 'filter.git-crypt.required', 'true'])
    if (!project.encryption) throw new WorkspaceError('encryptionRequired')
    const processDriver = await command(['config', '--local', '--unset-all', 'filter.git-crypt.process'])
    if (![0, 5].includes(processDriver.code)) throw new WorkspaceError('encryptionUnsafe')
    const binary = await this.binary(project.encryption)
    if (await this.internalKey(project)) {
      await this.sample(project, command, binary, join(project.path, '.git/git-crypt/keys/default'))
      this.bindings.set(project.path, binary)
      for (const [key, value] of Object.entries(filters(binary))) await this.checked(command, ['config', '--local', key, value])
      await this.decrypted(project, command)
      return
    }
    let keyFile: string | undefined
    if (project.encryption.keySource === 'file') {
      keyFile = await realpath(expand(project.encryption.keyFile)).catch(() => { throw new WorkspaceError('encryptionKey') })
      const info = await lstat(keyFile), inside = relative(join(project.path, '..'), keyFile)
      if (!info.isFile() || info.size > 16384 || (info.mode & 0o077) || (!inside.startsWith('..' + '/') && !isAbsolute(inside))) throw new WorkspaceError('encryptionKey')
      await this.sample(project, command, binary, keyFile)
    }
    const overrides = { 'core.hooksPath': this.hooks, 'core.fsmonitor': 'false', 'submodule.recurse': 'false', ...filters(binary),
      // Native unlock checks the still-encrypted working tree before installing its key.
      // This bypass only affects that owned process; the persisted driver stays required.
      'filter.git-crypt.clean': '', 'filter.git-crypt.required': 'false' }
    const env: NodeJS.ProcessEnv = { ...this.options().env, GIT_CONFIG_COUNT: String(Object.keys(overrides).length) }
    Object.entries(overrides).forEach(([key, value], index) => { env['GIT_CONFIG_KEY_' + index] = key; env['GIT_CONFIG_VALUE_' + index] = value })
    const result = await this.run(binary, ['unlock', ...(keyFile ? [keyFile] : [])], { ...this.options(), env, cwd: project.path, timeoutMs: 180_000, stdoutLimit: 0 })
    if (result.code !== 0) throw new WorkspaceError('encryptionUnlock')
    this.bindings.set(project.path, binary)
    for (const [key, value] of Object.entries(filters(binary))) await this.checked(command, ['config', '--local', key, value])
    if (!await this.internalKey(project)) throw new WorkspaceError('encryptionUnlock')
    await this.decrypted(project, command)
  }
  private async decrypted(project: Project, command: Command): Promise<void> {
    const paths = (await this.checked(command, ['ls-files', '-z'])).split('\0').filter(Boolean)
    for (const path of await this.protected(command, paths)) {
      let file
      try {
        const parent = relative(project.path, await realpath(dirname(join(project.path, path))))
        if (parent === '..' || parent.startsWith('../') || isAbsolute(parent)) throw new WorkspaceError('encryptionUnsafe')
        file = await open(join(project.path, path), constants.O_RDONLY | constants.O_NOFOLLOW)
        if (!(await file.stat()).isFile()) throw new WorkspaceError('encryptionUnsafe')
        const header = Buffer.alloc(10)
        await file.read(header, 0, 10, 0)
        if (header.equals(magic)) {
          const entry = await this.checked(command, ['ls-files', '--stage', '-z', '--', path])
          const hash = (await this.checked(command, ['hash-object', '--no-filters', '--', path])).trim()
          if (entry.split(' ')[1] !== hash) throw new WorkspaceError('encryptionUnlock')
          // Finish an interrupted unlock only for ciphertext identical to the index.
          // Plaintext edits and changed ciphertext are never checked out over.
          await file.close(); file = undefined
          await this.checked(command, ['checkout', '--', path])
          file = await open(join(project.path, path), constants.O_RDONLY | constants.O_NOFOLLOW)
          header.fill(0); await file.read(header, 0, 10, 0)
          if (header.equals(magic)) throw new WorkspaceError('encryptionUnlock')
        }
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
      finally { await file?.close() }
    }
  }
  async verifyTree(project: Project, command: Command, tree: string, paths: string[], env: NodeJS.ProcessEnv, prior = new Set<string>(), budget = { bytes: 0 }): Promise<void> {
    const protectedPaths = new Set([...prior, ...await this.protected(command, paths, env)])
    if (!protectedPaths.size) return
    const binary = this.bindings.get(project.path)
    if (!binary) throw new WorkspaceError('encryptionRequired')
    const directory = await mkdtemp(join(this.scratch, 'crypt-verify-'))
    try {
      for (const path of protectedPaths) {
        const entry = (await this.checked(command, ['ls-tree', '-l', '-z', tree, '--', path])).split('\0')[0]
        if (!entry) continue
        const record = /^100(?:644|755) blob [a-f0-9]+ +(\d+)\t/u.exec(entry)
        if (!record || Number(record[1]) < 22) throw new WorkspaceError('encryptionUnsafe')
        budget.bytes += Number(record[1])
        if (budget.bytes > 64 * 1024 * 1024) throw new WorkspaceError('encryptionAuditLimit')
        const result = await command(['cat-file', 'blob', tree + ':' + path], { maxBytes: 64 * 1024 * 1024, captureBinary: true })
        if (result.code !== 0 || !result.stdoutBytes?.subarray(0, 10).equals(magic)) throw new WorkspaceError('encryptionUnsafe')
        const cipher = join(directory, 'cipher')
        await writeFile(cipher, result.stdoutBytes, { mode: 0o600 })
        const verified = await this.run(binary, ['diff', cipher], { ...this.options(), cwd: project.path, stdoutLimit: 0, maxBytes: 64 * 1024 * 1024 })
        if (verified.code !== 0) throw new WorkspaceError('encryptionUnsafe')
      }
    } finally { await rm(directory, { recursive: true, force: true }) }
  }
  async protectedPaths(command: Command, paths: string[], env: NodeJS.ProcessEnv): Promise<Set<string>> { return this.protected(command, paths, env) }
  async plaintext(project: Project, paths: Iterable<string>): Promise<void> {
    for (const path of paths) {
      let file
      try {
        const parent = relative(project.path, await realpath(dirname(join(project.path, path))))
        if (parent === '..' || parent.startsWith('../') || isAbsolute(parent)) throw new WorkspaceError('encryptionUnsafe')
        file = await open(join(project.path, path), constants.O_RDONLY | constants.O_NOFOLLOW)
        if (!(await file.stat()).isFile()) throw new WorkspaceError('encryptionUnsafe')
        const header = Buffer.alloc(10)
        await file.read(header, 0, 10, 0)
        if (header.equals(magic)) throw new WorkspaceError('encryptionRequired')
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
      finally { await file?.close() }
    }
  }
  async audit(project: Project, command: Command): Promise<void> {
    if (!await this.ready(project, command)) return
    const branch = (await this.checked(command, ['symbolic-ref', '--short', 'HEAD'])).trim()
    const remote = (await this.checked(command, ['ls-remote', '--heads', 'origin', 'refs/heads/' + branch])).trim()
    const remoteHead = remote.split('\t')[0]!
    if (remote && !/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/u.test(remoteHead)) throw new WorkspaceError('encryptionUnsafe')
    if (remote && (await command(['cat-file', '-e', remoteHead + '^{commit}'])).code !== 0) throw new WorkspaceError('remoteChanged')
    const commits = (await this.checked(command, ['rev-list', '--max-count=101', 'HEAD', ...(remote ? ['--not', remoteHead] : [])])).trim().split('\n').filter(Boolean)
    if (commits.length > 100) throw new WorkspaceError('encryptionAuditLimit')
    const directory = await mkdtemp(join(this.scratch, 'crypt-audit-')), env = { ...this.options().env, GIT_INDEX_FILE: join(directory, 'index') }
    let count = 0
    const budget = { bytes: 0 }, trees = new Set(['HEAD', ...(remote ? [remoteHead] : [])])
    const changes: Array<{ commit: string; paths: string[] }> = [], allPaths = new Set<string>()
    try {
      for (const commit of commits) {
        const paths = (await this.checked(command, ['diff-tree', '--root', '--no-commit-id', '--name-only', '-r', '-z', '-m', commit])).split('\0').filter(Boolean)
        count += paths.length
        if (count > 2000) throw new WorkspaceError('encryptionAuditLimit')
        changes.push({ commit, paths })
        for (const path of paths) allPaths.add(path)
        trees.add(commit)
        const parents = (await this.checked(command, ['rev-list', '--parents', '-n', '1', commit])).trim().split(' ').slice(1)
        for (const parent of parents) trees.add(parent)
      }
      const protectedPaths = new Set<string>()
      // Keep every policy encountered: a rule removed in one commit must still
      // protect files changed later in the same outgoing history.
      for (const tree of trees) {
        await this.checked(command, ['read-tree', tree], { env })
        for (const path of await this.protected(command, [...allPaths], env)) protectedPaths.add(path)
      }
      for (const { commit, paths } of changes) {
        const prior = new Set(paths.filter(path => protectedPaths.has(path)))
        await this.checked(command, ['read-tree', commit], { env })
        await this.verifyTree(project, command, commit, paths, env, prior, budget)
      }
    } finally { await rm(directory, { recursive: true, force: true }) }
  }
}
