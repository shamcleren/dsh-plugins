import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { access, lstat, mkdir, mkdtemp, open, readdir, realpath, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { delimiter, dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runScanner } from './process.js'
import { gitVisibleFiles } from './repository.js'
import { RULES } from './rules.js'

export const SEMGREP_VERSION = '1.176.1'
const languages: Record<string, string> = { '.py': 'python', '.go': 'go', '.js': 'javascript', '.jsx': 'javascript', '.mjs': 'javascript', '.cjs': 'javascript', '.ts': 'typescript', '.tsx': 'typescript' }
const excluded = new Set(['.git', '.hg', '.svn', 'node_modules', 'vendor', '.venv', 'venv', 'env', '__pycache__', 'dist', 'build', 'coverage', '.next', '.pnpm-store'])
const inside = (root: string, path: string): boolean => path === root || path.startsWith(root + sep)
const object = (value: unknown): Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
export interface Finding { rule: string; file: string; line: number; cwe: string; title: string; status: 'needs-review'; anchor?: string }
export interface ScanOptions { workspace: string; path?: string; files?: readonly string[]; mode?: 'auto' | 'inventory' | 'semgrep'; semgrepPath?: string; signal: AbortSignal }

export async function executable(name: string, workspace: string): Promise<string | undefined> {
  const candidates = isAbsolute(name) ? [name] : ['semgrep', 'gitleaks'].includes(name)
    ? (process.env.PATH ?? '').split(delimiter).filter(isAbsolute).map(dir => join(dir, name)) : []
  for (const candidate of candidates) {
    try {
      const path = await realpath(candidate)
      if (inside(workspace, path)) continue
      await access(path, constants.X_OK)
      if ((await lstat(path)).isFile()) return path
    } catch (error) { if (!['ENOENT', 'EACCES', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error }
  }
  return undefined
}

/** Read a bounded source snapshot; never invoke project code, hooks, or configuration. */
export async function scanWorkspace(options: ScanOptions) {
  options.signal.throwIfAborted()
  if (!isAbsolute(options.workspace)) throw new Error('Select a DSH workspace before scanning')
  const workspace = await realpath(options.workspace)
  const root = await realpath(resolve(workspace, options.path ?? '.'))
  if (!inside(workspace, root) || !(await lstat(root)).isDirectory()) throw new Error('Scan path must be a directory inside the current workspace')
  const scratch = await mkdtemp(join(tmpdir(), 'dsh-security-scan-'))
  const snapshot = join(scratch, 'source')
  const files: Array<{ path: string; language: string }> = []
  const skipped: Record<string, number> = { excluded: 0, symlink: 0, oversized: 0, unsupported: 0, changed: 0 }
  let totalBytes = 0, limited = false, visited = 0
  try {
    await mkdir(snapshot)
    const visible = await gitVisibleFiles(root, options.signal)
    const pending = [root]
    while (pending.length && !limited) {
      const directory = pending.pop()!
      options.signal.throwIfAborted()
      for (const item of await readdir(directory, { withFileTypes: true })) {
        if (++visited > 20_000 || files.length >= 5000) { limited = true; break }
        if (item.isSymbolicLink()) { skipped.symlink!++; continue }
        if (excluded.has(item.name)) { skipped.excluded!++; continue }
        const path = join(directory, item.name)
        if (item.isFile() && visible && !visible.has(relative(root, path))) { skipped.excluded!++; continue }
        if (item.isFile() && options.files && !options.files.includes(relative(root, path))) continue
        if (item.isDirectory()) { if (!visible || [...visible].some(file => file.startsWith(relative(root, path) + "/"))) pending.push(path); continue }
        const language = languages[extname(item.name)]
        if (!item.isFile() || !language) { skipped.unsupported!++; continue }
        const physical = await realpath(path)
        if (!inside(root, physical)) throw new Error('Source path escaped the scan root')
        const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
        try {
          const stat = await file.stat()
          if (!stat.isFile() || stat.size > 1024 * 1024) { skipped.oversized!++; continue }
          if (totalBytes + stat.size > 64 * 1024 * 1024) { limited = true; break }
          const buffer = Buffer.alloc(stat.size + 1)
          const { bytesRead } = await file.read(buffer, 0, buffer.length, 0)
          const after = await file.stat()
          if (bytesRead !== stat.size || after.size !== stat.size || after.mtimeMs !== stat.mtimeMs) { skipped.changed!++; continue }
          if (buffer.subarray(0, bytesRead).includes(0)) { skipped.unsupported!++; continue }
          const name = relative(root, path)
          const destination = join(snapshot, name)
          await mkdir(dirname(destination), { recursive: true })
          await writeFile(destination, buffer.subarray(0, bytesRead), { mode: 0o600 })
          files.push({ path: name, language }); totalBytes += bytesRead
        } finally { await file.close() }
      }
    }
    const coverage = { root: relative(workspace, root) || '.', files: files.length, bytes: totalBytes,
      languages: [...new Set(files.map(file => file.language))], limited, skipped,
      inventory: files.slice(0, 200), inventoryOmitted: Math.max(0, files.length - 200) }
    const base = { coverage, rules: Object.keys(RULES).length, findings: [] as Finding[], llmReviewRequired: true }
    if (options.mode === 'inventory' || files.length === 0) return { ...base, status: 'inventory-only' as const }
    const binary = await executable(options.semgrepPath ?? 'semgrep', workspace)
    if (!binary) return { ...base, status: 'scanner-unavailable' as const, guidance: `Use DSH security-review for LLM review, or configure semgrepPath for Semgrep ${SEMGREP_VERSION}. No static scan was performed.` }
    const version = await runScanner(binary, ['--version'], scratch, options.signal)
    if (version.code !== 0 || version.stdout.trim() !== SEMGREP_VERSION) return { ...base, status: 'unsupported-scanner' as const, guidance: `This plugin is verified with Semgrep ${SEMGREP_VERSION}. No static scan was performed.` }
    const findings: Finding[] = [], scannedPaths = new Set<string>()
    let errors = 0, failedBatches = 0
    // Bound each process without silently dropping later files in a full scan.
    for (let offset = 0; offset < files.length; offset += 250) {
    const batch = files.slice(offset, offset + 250)
    const scan = await runScanner(binary, ['scan', '--oss-only', '--config', fileURLToPath(new URL('../rules/baseline.yml', import.meta.url)),
      '--json', '--metrics=off', '--disable-version-check', '--disable-nosem', '--no-git-ignore', '--no-rewrite-rule-ids',
      '--jobs=2', '--max-target-bytes=1048576', '--timeout=5', '--timeout-threshold=1', ...batch.map(file => './' + file.path)], snapshot, options.signal).catch(() => { options.signal.throwIfAborted(); return { code: -1, stdout: '' } })
    if (scan.code !== 0) { failedBatches++; continue }
    const output = object(JSON.parse(scan.stdout))
    if (!Array.isArray(output.results) || !Array.isArray(output.errors)) throw new Error('Invalid scanner response')
    const allowed = new Set(batch.map(file => file.path))
    for (const raw of output.results) {
      const result = object(raw), start = object(result.start)
      if (typeof result.check_id !== 'string' || !Object.hasOwn(RULES, result.check_id) || typeof result.path !== 'string') throw new Error('Unknown scanner finding')
      const file = relative(snapshot, resolve(snapshot, result.path))
      if (!allowed.has(file) || !Number.isSafeInteger(start.line) || Number(start.line) < 1) throw new Error('Scanner returned an out-of-scope finding')
      const rule = RULES[result.check_id]!
      const end = object(result.end), bytes = await readFile(join(snapshot, file))
      const validOffsets = Number.isSafeInteger(start.offset) && Number.isSafeInteger(end.offset) && Number(start.offset) >= 0 && Number(end.offset) > Number(start.offset) && Number(end.offset) <= bytes.length
      const anchor = validOffsets ? createHash('sha256').update(bytes.subarray(Number(start.offset), Number(end.offset)).toString('utf8').trim().replace(/\s+/gu, ' ')).digest('hex') : undefined
      findings.push({ rule: result.check_id, file, line: Number(start.line), cwe: rule.cwe, title: rule.title, status: 'needs-review', ...(anchor ? { anchor } : {}) })
    }
    const scanned = object(output.paths).scanned
    if (Array.isArray(scanned)) for (const path of scanned) {
      if (typeof path !== 'string') continue
      const name = relative(snapshot, resolve(snapshot, path))
      if (allowed.has(name)) scannedPaths.add(name)
    }
    errors += output.errors.length
    }
    const scannedFiles = scannedPaths.size
    return { ...base, status: failedBatches && !scannedFiles ? 'scanner-failed' as const : limited || skipped.oversized! > 0 || skipped.changed! > 0 || errors > 0 || failedBatches > 0 || scannedFiles < files.length ? 'partial' as const : 'completed' as const,
      scanner: { name: 'semgrep-ce', version: SEMGREP_VERSION }, scannedFiles, errors, failedBatches,
      findings: findings.slice(0, 2000), findingsOmitted: Math.max(0, findings.length - 2000) }
  } finally { await rm(scratch, { recursive: true, force: true }) }
}
