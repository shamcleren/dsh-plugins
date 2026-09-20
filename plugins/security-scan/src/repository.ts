import { constants } from 'node:fs'
import { createHash } from 'node:crypto'
import { lstat, mkdir, mkdtemp, open, readdir, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir, homedir } from 'node:os'
import { dirname, join, relative, resolve, isAbsolute } from 'node:path'
import { runScanner } from './process.js'

export type Scope = 'full' | 'diff' | 'staged'
export const hash = (value: string | Buffer): string => createHash('sha256').update(value).digest('hex')
export const inside = (root: string, path: string): boolean => path === root || path.startsWith(root + '/')
export interface Snapshot { path: string; files: Record<string, string>; skipped: number; limited: boolean; digest: string; omissions?: Array<{ file: string; reason: string }> }
export interface Source {
  root: string; identity: string; commit?: string; baseCommit?: string; source: string; scope: Scope
  current: Snapshot; previous?: Snapshot; changed: string[]; renames: Record<string, string>; dispose(): Promise<void>
}
const excluded = new Set(['.git', '.hg', '.svn', 'node_modules', 'vendor', '.venv', 'venv', '__pycache__', 'dist', 'build', 'coverage', '.next', '.pnpm-store', '.dsh-security'])
const safePath = (name: string): boolean => name.length > 0 && !isAbsolute(name) && !name.split('/').some(part => part === '..' || excluded.has(part)) && !/[\x00-\x1f\x7f]/u.test(name)
export async function git(root: string, args: string[], signal: AbortSignal, allowFailure = false): Promise<string> {
  // Keep trusted system Git configuration: Apple's Git registers the Keychain
  // credential helper there. Command-scoped options below still disable hooks,
  // external diffs and unsafe transports for the temporary bare clone.
  const env: Record<string, string> = { PATH: '/usr/bin:/bin:/opt/homebrew/bin', HOME: homedir(), GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0' }
  if (process.env.SSH_AUTH_SOCK) env.SSH_AUTH_SOCK = process.env.SSH_AUTH_SOCK
  const result = await runScanner('/usr/bin/git', ['--literal-pathspecs', '-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', '-c', 'protocol.ext.allow=never', '-c', 'protocol.file.allow=never', '-c', 'diff.external=', ...args], root, signal, env)
  if (result.code && !allowFailure) throw new Error('Git operation failed: ' + args[0] + '. Check repository access, ref and available history.')
  return result.code ? '' : result.stdout
}
export function validateRepositoryUrl(value: string): string {
  if (/^git@[a-zA-Z0-9.-]+:[a-zA-Z0-9_./-]+(?:\.git)?$/u.test(value)) return value
  const url = new URL(value)
  if (!['https:', 'ssh:'].includes(url.protocol) || url.password || url.search || url.hash || (url.username && !(url.protocol === 'ssh:' && url.username === 'git'))) throw new Error('Use an HTTPS or SSH repository URL without embedded credentials')
  return url.href
}
/** Git applies nested ignore files, negation and global excludes; tracked files remain visible. */
export async function gitVisibleFiles(root: string, signal: AbortSignal): Promise<Set<string> | undefined> {
  if (!(await git(root, ['rev-parse', '--is-inside-work-tree'], signal, true)).trim()) return undefined
  return new Set((await git(root, ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], signal)).split('\0').filter(Boolean))
}
async function snapshot(root: string, output: string, signal: AbortSignal, revision?: string): Promise<Snapshot> {
  await mkdir(output)
  const files: Record<string, string> = {}; let skipped = 0, limited = false, total = 0, visited = 0
  const omissions: Array<{ file: string; reason: string }> = []
  const omit = (file: string, reason: string): void => { skipped++; limited = true; if (omissions.length < 100) omissions.push({ file, reason }) }
  async function save(name: string, bytes: Buffer): Promise<void> {
    if (!safePath(name) || bytes.includes(0)) { skipped++; return }
    if (bytes.length > 1024 * 1024 || Object.keys(files).length >= 5000 || total + bytes.length > 64 * 1024 * 1024) { omit(name, bytes.length > 1024 * 1024 ? '单文件超过 1 MiB' : Object.keys(files).length >= 5000 ? '文件数超过 5000' : '快照超过 64 MiB'); return }
    signal.throwIfAborted(); total += bytes.length
    const path = join(output, name); await mkdir(dirname(path), { recursive: true }); await writeFile(path, bytes, { mode: 0o600 }); files[name] = hash(bytes)
  }
  if (revision) {
    const rows = (await git(root, revision === 'index' ? ['ls-files', '--stage', '-z'] : ['ls-tree', '-rlz', revision], signal)).split('\0').filter(Boolean)
    for (const row of rows) {
      if (++visited > 20000) { limited = true; skipped += rows.length - visited + 1; break }
      const tab = row.indexOf('\t'), name = row.slice(tab + 1), meta = row.slice(0, tab).split(/\s+/u)
      const mode = meta[0], oid = meta[revision === 'index' ? 1 : 2]
      if (tab < 0 || !oid || !/^100(?:644|755)$/u.test(mode ?? '') || !safePath(name)) { skipped++; continue }
      if (revision === 'index' && meta[2] !== '0') throw new Error('Resolve staged merge conflicts before scanning')
      const size = revision === 'index' ? Number(await git(root, ['cat-file', '-s', oid], signal)) : Number(meta[3])
      if (size > 1024 * 1024 || total + size > 64 * 1024 * 1024 || Object.keys(files).length >= 5000) { omit(name, size > 1024 * 1024 ? '单文件超过 1 MiB' : Object.keys(files).length >= 5000 ? '文件数超过 5000' : '快照超过 64 MiB'); continue }
      await save(name, Buffer.from(await git(root, ['cat-file', 'blob', oid], signal)))
    }
  } else {
    const visible = await gitVisibleFiles(root, signal)
    const pending = [root]
    while (pending.length) {
      const directory = pending.pop()!
      for (const item of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
        if (++visited > 20000) { skipped++; limited = true; return finish() }
        const path = join(directory, item.name), name = relative(root, path)
        if (!safePath(name) || item.isSymbolicLink()) { skipped++; continue }
        if (item.isDirectory()) { if (!visible || [...visible].some(file => file.startsWith(name + "/"))) pending.push(path); continue }
        if (!item.isFile() || (visible && !visible.has(name))) continue
        if (!inside(root, await realpath(path))) throw new Error('Snapshot path escaped the repository')
        const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
        try {
          const before = await file.stat()
          if (before.size > 1024 * 1024 || total + before.size > 64 * 1024 * 1024) { omit(name, before.size > 1024 * 1024 ? '单文件超过 1 MiB' : '快照超过 64 MiB'); continue }
          const bytes = Buffer.alloc(before.size + 1); const { bytesRead } = await file.read(bytes, 0, bytes.length, 0); const after = await file.stat()
          if (bytesRead !== before.size || after.size !== before.size || after.mtimeMs !== before.mtimeMs) { omit(name, '读取期间文件发生变化'); continue }
          await save(name, bytes.subarray(0, bytesRead))
        } finally { await file.close() }
      }
    }
  }
  return finish()
  function finish(): Snapshot { return { path: output, files, skipped, limited, omissions, digest: hash(JSON.stringify(Object.entries(files).sort())) } }
}
/** No checkout, filters, submodules, project hooks, or dependency installation are executed. */
export async function prepareSource(options: { target: string; url?: string; ref?: string; scope: Scope; base?: string; signal: AbortSignal }): Promise<Source> {
  if (options.scope === 'staged' && (options.url || options.ref || options.base)) throw new Error('Staged scans compare the index with HEAD; URL, ref and base are not accepted')
  const scratch = await mkdtemp(join(tmpdir(), 'dsh-audit-'))
  try {
    let root = await realpath(options.target), source = root, revision: string | undefined
    if (options.url) {
      source = validateRepositoryUrl(options.url); root = join(scratch, 'repository.git')
      await git(scratch, ['clone', '--bare', '--no-local', '--', source, root], options.signal)
      if (options.scope === 'staged') throw new Error('Staged scans require a local working repository')
    }
    const resolveRef = async (ref: string): Promise<string> => {
      const value = (await git(root, ['rev-parse', '--verify', '--end-of-options', ref + '^{commit}'], options.signal)).trim()
      if (!/^[a-f0-9]{40,64}$/u.test(value)) throw new Error('Invalid Git commit')
      return value
    }
    const head = (await git(root, ['rev-parse', '--verify', 'HEAD'], options.signal, true)).trim()
    const commit = options.ref ? await resolveRef(options.ref) : head || undefined
    if (options.ref || options.url) revision = commit
    if (options.scope === 'staged') revision = 'index'
    let baseCommit: string | undefined
    if (options.base) {
      const base = await resolveRef(options.base)
      baseCommit = options.scope === 'diff' && commit ? (await git(root, ['merge-base', base, commit], options.signal)).trim() : base
    } else if (options.scope === 'staged') baseCommit = commit
    else if (options.scope === 'diff') throw new Error('Diff scans require --base <target-branch-or-commit>; no baseline is guessed')
    if (options.scope !== 'full' && !head && options.scope !== 'staged') throw new Error('This mode requires Git history')
    const current = await snapshot(root, join(scratch, 'current'), options.signal, revision)
    const previous = baseCommit ? await snapshot(root, join(scratch, 'previous'), options.signal, baseCommit) : undefined
    const changed = [...new Set([...Object.keys(current.files), ...Object.keys(previous?.files ?? {})])].filter(name => current.files[name] !== previous?.files[name]).sort()
    const renames: Record<string, string> = {}
    if (previous) for (const name of changed.filter(name => !previous.files[name] && current.files[name])) {
      const old = changed.filter(old => !current.files[old] && previous.files[old] === current.files[name])
      if (old.length === 1) renames[name] = old[0]!
    }
    const top = options.url ? source : (await git(root, ['rev-parse', '--show-toplevel'], options.signal, true)).trim() || root
    return { root, source, identity: hash(options.url ? source : top + '\0' + relative(top, root)), scope: options.scope, ...(commit ? { commit } : {}), ...(baseCommit ? { baseCommit } : {}),
      current, ...(previous ? { previous } : {}), changed, renames, dispose: () => rm(scratch, { recursive: true, force: true }) }
  } catch (error) { await rm(scratch, { recursive: true, force: true }); throw error }
}
