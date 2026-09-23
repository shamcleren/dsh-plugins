import { ArchiveSchema, mergeArchives, type EvidenceArchive } from './report-evidence.js'
import { renderReportView } from './report-view.js'
import { randomUUID } from 'node:crypto'
import { lstat, mkdir, readFile, readdir, realpath, rename, rm, rmdir, unlink, writeFile } from 'node:fs/promises'
import { join, resolve, relative, isAbsolute } from 'node:path'
import { homedir } from 'node:os'
import { z } from 'zod'
import { AgentAuditSchema, type AgentAudit } from './agent-contract.js'
import { ReportItemSchema, type ReportItem } from './ui-contract.js'

const text = z.string().max(12000)
const path = z.string().max(2000).refine(value => !isAbsolute(value) && !value.split('/').includes('..') && !/[\x00-\x1f]/u.test(value))
const CitationsSchema = z.array(z.object({ file: path, start: z.number().int().positive(), end: z.number().int().positive() }).strict()).max(10)
export const ReviewSchema = z.object({
  findingId: z.string(), status: z.enum(['confirmed', 'needs-review', 'dismissed']),
  severity: z.enum(['critical', 'high', 'medium', 'low', 'info']), evidence: text.min(1),
  recommendation: text.min(1), verification: text.min(1), reviewer: text.min(1), citations: CitationsSchema.optional(),
}).strict()
export const FindingSchema = z.object({
  id: z.string().max(200), fingerprint: z.string().max(200), engine: z.string().max(100), rule: z.string().max(200),
  file: path, line: z.number().int().positive(), title: text, cwe: z.string().max(100),
  severity: z.enum(['critical', 'high', 'medium', 'low', 'info']), status: z.enum(['confirmed', 'needs-review', 'dismissed']),
  change: z.enum(['new', 'existing', 'unknown', 'not-observed']), evidence: text, recommendation: text, verification: text, citations: CitationsSchema.optional(),
  dependency: z.object({ name: z.string().max(300), version: z.string().max(200), ecosystem: z.string().max(100),
    advisoryId: z.string().max(150), aliases: z.array(z.string().max(150)).max(100), fixedVersions: z.array(z.string().max(200)).max(100),
    summary: text, references: z.array(z.string().max(2000)).max(30), metadataAvailable: z.boolean(), locationExact: z.boolean(),
  }).strict().optional(),
}).strict()
export const PLUGIN_VERSION = '0.11.2' as const
export const ReportSchema = z.object({
  schemaVersion: z.literal(1), pluginVersion: z.enum(['0.2.0', '0.3.0', '0.4.0', '0.5.0', '0.6.0', '0.7.0', '0.8.0', '0.8.1', '0.8.2', '0.9.0', '0.9.1', '0.10.0', '0.10.1', '0.10.2', '0.10.3', '0.11.1', PLUGIN_VERSION]), id: z.string().uuid(), createdAt: z.string().datetime(),
  source: z.object({ identity: z.string(), label: text, revision: z.enum(['working-tree', 'index', 'commit']), scope: z.enum(['full', 'diff', 'staged']), commit: z.string().optional(), baseCommit: z.string().optional(), digest: z.string(), files: z.record(path, z.string()), changed: z.array(path).max(10000), skipped: z.number().int().nonnegative() }).strict(),
  policy: z.object({ engine: z.string(), rulesDigest: z.string(), dependencies: z.boolean(), secrets: z.boolean(), view: z.enum(['all', 'new']), failOn: z.enum(['none', 'high', 'medium']) }).strict(),
  engines: z.array(z.object({ name: z.string(), version: z.string(), status: z.enum(['completed', 'partial', 'unavailable', 'failed', 'skipped']), detail: text }).strict()).max(10),
  coverage: z.object({ files: z.number(), scannedFiles: z.number(), omittedFindings: z.number(), detail: text }).strict(),
  findings: z.array(FindingSchema).max(2000), baseline: z.object({ id: z.string(), comparable: z.boolean(), reason: text, notObserved: z.array(FindingSchema).max(2000) }).optional(),
  evidenceArchive: ArchiveSchema.optional(),
  reviews: z.array(ReviewSchema).max(2000), notes: z.array(text).max(100), parentReport: z.string().uuid().optional(), agent: AgentAuditSchema.optional(),
}).strict().superRefine((report, context) => {
  for (const [index, snippet] of (report.evidenceArchive?.snippets ?? []).entries()) if (!Object.hasOwn(report.source.files, snippet.file) || report.source.files[snippet.file] !== snippet.sourceHash) context.addIssue({ code: 'custom', path: ['evidenceArchive', 'snippets', index], message: 'Evidence must match the recorded source digest' })
})
export type Report = z.infer<typeof ReportSchema>
export type Finding = z.infer<typeof FindingSchema>
export const AdditionalFindingSchema = FindingSchema.pick({ file: true, line: true, title: true, cwe: true, severity: true, status: true, evidence: true, recommendation: true, verification: true, citations: true }).extend({ evidence: text.min(1), recommendation: text.min(1), verification: text.min(1) }).strict()
export type AdditionalFinding = z.infer<typeof AdditionalFindingSchema>
export type Review = z.infer<typeof ReviewSchema>
export const defaultReportsRoot = (): string => join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'security-scan/reports')
export async function readReport(file: string): Promise<Report> {
  const stat = await lstat(file)
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 16 * 1024 * 1024) throw new Error('Invalid or oversized report file')
  return ReportSchema.parse(JSON.parse(await readFile(file, 'utf8')))
}
export async function writeReport(root: string, value: Report, draft = false): Promise<{ json: string; html: string }> {
  const report = ReportSchema.parse(value)
  const json = JSON.stringify(report, null, 2) + '\n'
  if (Buffer.byteLength(json) > 16 * 1024 * 1024) throw new Error('Report exceeds 16 MiB; reduce scan or review scope')
  await mkdir(root, { recursive: true, mode: 0o700 })
  if ((await lstat(root)).isSymbolicLink()) throw new Error('Report directory cannot be a symlink')
  const directory = join(root, report.id), stage = join(root, '.report-' + randomUUID())
  await mkdir(stage, { mode: 0o700 })
  try {
    await writeFile(join(stage, 'report.json'), json, { flag: 'wx', mode: 0o600 })
    if (!draft) await writeFile(join(stage, 'report.html'), renderReport(report), { flag: 'wx', mode: 0o600 })
    try { await lstat(directory); throw new Error('Report already exists; create a new report revision') } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
    await rename(stage, directory)
  } finally { await rm(stage, { recursive: true, force: true }) }
  return { json: join(directory, 'report.json'), html: join(directory, 'report.html') }
}
/** Reviews create another immutable JSON/HTML pair, preserving original scanner evidence. */
export async function reviewReport(file: string, reviews: Review[], root: string, additional: AdditionalFinding[] = [], agent?: AgentAudit, retainParent = true, reportId = randomUUID(), evidenceArchive?: EvidenceArchive): Promise<{ json: string; html: string }> {
  const original = await readReport(file), entries = z.array(ReviewSchema).max(2000).parse(reviews)
  if (new Set(entries.map(item => item.findingId)).size !== entries.length) throw new Error('Duplicate review finding IDs')
  for (const review of entries) if (!original.findings.some(item => item.id === review.findingId)) throw new Error('Review refers to an unknown finding')
  const additions = z.array(AdditionalFindingSchema).max(100).parse(additional)
  for (const item of additions) if (!Object.hasOwn(original.source.files, item.file)) throw new Error('Additional finding is outside the scanned snapshot')
  const report: Report = { ...original, pluginVersion: PLUGIN_VERSION, id: reportId, createdAt: new Date().toISOString(), ...(retainParent ? { parentReport: original.id } : { parentReport: undefined }),
    ...(agent ? { agent: AgentAuditSchema.parse(agent) } : {}),
    reviews: [...original.reviews.filter(old => !entries.some(next => next.findingId === old.findingId)), ...entries],
    notes: [...original.notes.filter(note => !note.startsWith('LLM 复核尚未执行')), agent && agent.status !== 'completed' ? 'AI 流程未完成；仅保留已获取的证据和部分结论。' : '已保存人工或模型复核；范围以 reviews 和 llm 来源的问题为准，其他部分不视为已复核。'],
    findings: original.findings.map(item => { const review = entries.find(entry => entry.findingId === item.id); return review ? { ...item, status: review.status, severity: review.severity, evidence: review.evidence, recommendation: review.recommendation, verification: review.verification, ...(review.citations ? { citations: review.citations } : {}) } : item }).concat(additions.map(item => ({ ...item, id: randomUUID(), fingerprint: randomUUID(), engine: 'llm', rule: 'llm-context-review', change: 'unknown' as const }))) }
  report.evidenceArchive = mergeArchives(report, evidenceArchive)
  return writeReport(root, report)
}
export function exitCode(report: Report): number {
  if (report.agent?.status === 'incomplete') return 2
  if (report.engines.some(engine => ['partial', 'unavailable', 'failed'].includes(engine.status)) || report.coverage.omittedFindings > 0) return 2
  if (report.policy.failOn === 'none') return 0
  const levels = report.policy.failOn === 'high' ? ['critical', 'high'] : ['critical', 'high', 'medium']
  return report.findings.some(item => item.change === 'new' && item.status === 'confirmed' && levels.includes(item.severity)) ? 1 : 0
}
export function reportFile(root: string, id: string): string {
  z.string().uuid().parse(id)
  const file = resolve(root, id, 'report.json')
  if (relative(resolve(root), file).startsWith('..')) throw new Error('Invalid report location')
  return file
}
/** Quarantine an owned report pair before changing history; never recursively remove user content. */
export async function stageReportDeletion(file: string, id: string): Promise<{ restore(): Promise<void>; finish(): Promise<void> }> {
  z.string().uuid().parse(id)
  const directory = resolve(file, '..'), root = resolve(directory, '..')
  if (file !== reportFile(root, id) || (await lstat(root)).isSymbolicLink()) throw new Error('Unsafe report root')
  const stat = await lstat(directory)
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Unsafe report directory')
  const canonicalRoot = await realpath(root)
  if (await realpath(directory) !== join(canonicalRoot, id)) throw new Error('Unsafe report directory')
  const names = await readdir(directory)
  if (!names.includes('report.json') || names.some(name => !['report.json', 'report.html'].includes(name))) throw new Error('Unknown report contents')
  for (const name of names) {
    const entry = await lstat(join(directory, name))
    if (!entry.isFile() || entry.isSymbolicLink()) throw new Error('Unsafe report file')
  }
  if ((await readReport(file)).id !== id) throw new Error('Report identity mismatch')
  const current = await lstat(directory)
  if (current.ino !== stat.ino || current.dev !== stat.dev) throw new Error('Report changed')
  const stage = join(canonicalRoot, '.deleted-' + randomUUID())
  await rename(directory, stage)
  return {
    restore: () => rename(stage, directory),
    finish: async () => { for (const name of names) await unlink(join(stage, name)); await rmdir(stage) },
  }
}
function listAgent(report: Report): ReportItem['agent'] {
  const ai = report.agent
  if (!ai) return
  const model = [ai.provider, ai.model].filter(Boolean).join('/')
  if (!model && !ai.usageAvailable) return
  return { model, usageAvailable: ai.usageAvailable, inputTokens: ai.inputTokens, outputTokens: ai.outputTokens, cacheReadTokens: ai.cacheReadTokens }
}

export async function listReports(root: string, source?: string): Promise<ReportItem[]> {
  let names: string[]
  try { names = await readdir(root) } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error }
  const dirs = await Promise.all(names.filter(name => z.string().uuid().safeParse(name).success).map(async name => ({ name, stat: await lstat(join(root, name)) })))
  const result = []
  for (const entry of dirs.filter(entry => entry.stat.isDirectory() && !entry.stat.isSymbolicLink()).sort((a, b) => b.stat.mtimeMs - a.stat.mtimeMs).slice(0, 200)) {
    const json = join(root, entry.name, 'report.json'), report = await readReport(json)
    if (source && report.source.label !== source) continue
    const agent = listAgent(report)
    result.push(ReportItemSchema.parse({ id: report.id, createdAt: report.createdAt, source: report.source.label, scope: report.source.scope, findings: report.findings.length, json, html: join(root, entry.name, 'report.html'), ...(agent ? { agent } : {}) }))
    if (result.length >= 20) break
  }
  return result
}
export function renderReport(input: Report): string { return renderReportView(ReportSchema.parse(input)) }
export function sarif(report: Report): unknown {
  return { version: '2.1.0', $schema: 'https://json.schemastore.org/sarif-2.1.0.json', runs: [{ tool: { driver: { name: 'dsh-security-scan', version: report.pluginVersion } }, results: report.findings.filter(item => item.status !== 'dismissed').map(item => ({ ruleId: item.rule, level: ['critical', 'high'].includes(item.severity) ? 'error' : 'warning', message: { text: item.title + '\n' + item.recommendation }, locations: [{ physicalLocation: { artifactLocation: { uri: item.file.split('/').map(encodeURIComponent).join('/') }, region: { startLine: item.line } } }], partialFingerprints: { primaryLocationLineHash: item.fingerprint }, properties: { status: item.status, change: item.change } })) }] }
}
