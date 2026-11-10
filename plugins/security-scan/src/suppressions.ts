import { randomUUID } from 'node:crypto'
import { lstat, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { z } from 'zod'
import { acquirePidLock } from './lock.js'
import { defaultReportsRoot, type Finding, type Report } from './report.js'
import { SuppressionSchema, SuppressRequestSchema, type Suppression } from './ui-contract.js'

export class SuppressionError extends Error { constructor(readonly code: string) { super(code) } }
const OWNER = 'dsh-security-suppressions-v1'
export const SUPPRESSION_LIMIT = 5000
const StoreSchema = z.object({ owner: z.literal(OWNER), items: z.array(SuppressionSchema).max(SUPPRESSION_LIMIT) }).strict()
/** Kept beside tasks.json but in its own file, so the CLI, Git hooks and the plugin share one list. */
export const defaultSuppressionsFile = (): string => join(dirname(defaultReportsRoot()), 'suppressions.json')
/** AI findings receive random fingerprints per run and cannot be matched in a later scan. */
export const suppressible = (finding: Pick<Finding, 'engine'>): boolean => finding.engine !== 'llm'
type Identity = Pick<Suppression, 'sourceIdentity' | 'engine' | 'rule' | 'file' | 'fingerprint'>
const key = (value: Identity): string => JSON.stringify([value.sourceIdentity, value.engine, value.rule, value.file, value.fingerprint])

export async function readSuppressions(file: string): Promise<Suppression[]> {
  let stat
  try { stat = await lstat(file) } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 8 * 1024 * 1024) throw new SuppressionError('unsafe-suppressions')
  try { return StoreSchema.parse(JSON.parse(await readFile(file, 'utf8'))).items }
  catch { throw new SuppressionError('unsafe-suppressions') }
}
/** Read-modify-write under a short PID lock; readers rely on the atomic rename and never take the lock. */
async function update<T>(file: string, operation: (items: Suppression[]) => { items: Suppression[]; result: T }): Promise<T> {
  const directory = dirname(file), lockPath = join(directory, '.' + basename(file) + '.lock')
  await mkdir(directory, { recursive: true, mode: 0o700 })
  if ((await lstat(directory)).isSymbolicLink()) throw new SuppressionError('unsafe-suppressions')
  const lock = await acquirePidLock(lockPath, join(directory, '.' + basename(file) + '-recovery.lock'), () => new SuppressionError('suppressions-locked'))
  try {
    await lock.writeFile(String(process.pid) + '\n')
    const { items, result } = operation(await readSuppressions(file))
    const document = JSON.stringify(StoreSchema.parse({ owner: OWNER, items }), null, 2) + '\n'
    const next = join(directory, '.' + basename(file) + '-' + randomUUID() + '.tmp')
    try { await writeFile(next, document, { flag: 'wx', mode: 0o600 }); await rename(next, file) }
    finally { await rm(next, { force: true }) }
    return result
  } finally { await lock.close(); await rm(lockPath, { force: true }) }
}

/** Record the selected findings of one report as false positives for that repository. Repeating a decision is a no-op. */
export async function addSuppressions(file: string, report: Report, findingIds: string[], reason: string, now = new Date()): Promise<{ added: number; existing: number }> {
  const request = SuppressRequestSchema.parse({ id: report.id, findingIds, reason })
  if (new Set(request.findingIds).size !== request.findingIds.length) throw new SuppressionError('unknown-finding')
  const findings = request.findingIds.map(id => report.findings.find(item => item.id === id))
  if (findings.some(item => !item)) throw new SuppressionError('unknown-finding')
  if (findings.some(item => !suppressible(item!))) throw new SuppressionError('finding-not-suppressible')
  return update(file, items => {
    const known = new Set(items.map(key)), next = [...items]
    let existing = 0
    for (const finding of findings as Finding[]) {
      const record: Suppression = { id: randomUUID(), sourceIdentity: report.source.identity, sourceLabel: report.source.label.slice(0, 2000), engine: finding.engine, rule: finding.rule, file: finding.file,
        fingerprint: finding.fingerprint, title: finding.title.slice(0, 500), reason: request.reason, createdAt: now.toISOString(), reportId: report.id }
      if (known.has(key(record))) { existing++; continue }
      known.add(key(record)); next.push(record)
    }
    if (next.length > SUPPRESSION_LIMIT) throw new SuppressionError('suppression-limit')
    return { items: next, result: { added: next.length - items.length, existing } }
  })
}
export async function removeSuppression(file: string, id: string): Promise<void> {
  z.string().uuid().parse(id)
  return update(file, items => {
    if (!items.some(item => item.id === id)) throw new SuppressionError('suppression-not-found')
    return { items: items.filter(item => item.id !== id), result: undefined }
  })
}
/** Find the user's decision for a finding; renamed files intentionally stop matching. */
export function suppressionFor(items: readonly Suppression[], identity: string): (finding: Finding) => Suppression | undefined {
  const index = new Map(items.filter(item => item.sourceIdentity === identity).map(item => [key(item), item]))
  return finding => suppressible(finding) ? index.get(key({ sourceIdentity: identity, engine: finding.engine, rule: finding.rule, file: finding.file, fingerprint: finding.fingerprint })) : undefined
}
/** Mark matching findings dismissed while keeping their fingerprints for baseline comparison. */
export function applySuppressions(report: Report, items: readonly Suppression[], identity = report.source.identity): Report {
  const match = suppressionFor(items, identity)
  let count = 0
  const findings = report.findings.map(item => {
    const found = match(item)
    if (!found) return item
    count++
    return { ...item, status: 'dismissed' as const, suppression: { id: found.id, reason: found.reason, createdAt: found.createdAt } }
  })
  if (!count) return report
  return { ...report, findings, notes: [...report.notes, '已按你之前的排除记录将 ' + count + ' 条问题标记为已排除并默认隐藏；不计入失败阈值，也不进入 AI 复核。可在插件设置的“已排除的问题”中恢复，或使用 dsh-security suppress 管理。'] }
}
