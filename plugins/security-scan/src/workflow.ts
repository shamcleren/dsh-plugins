import { captureScanEvidence } from './report-evidence.js'
import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { scanWorkspace, executable, SEMGREP_VERSION } from './scanner.js'
import { prepareSource, hash, type Scope, type Source, type Snapshot } from './repository.js'
import { enrich, scanDependencies, scanSecrets } from './engines.js'
import { mergeDynamic, scanDynamic } from './dynamic.js'
import { PLUGIN_VERSION, readReport, writeReport, defaultReportsRoot, type Report, type Finding } from './report.js'
import { RULES } from './rules.js'
import { applySuppressions, readSuppressions } from './suppressions.js'
import type { Suppression } from './ui-contract.js'

export interface AuditOptions {
  target: string; url?: string; ref?: string; scope?: Scope; base?: string; baseline?: string; output?: string
  engine?: 'auto' | 'semgrep' | 'inventory'; semgrepPath?: string; gitleaksPath?: string; dependencies?: boolean; secrets?: boolean
  /** Explicitly authorized HTTP(S) service for the read-only runtime baseline. */
  dynamicUrl?: string
  fetcher?: typeof fetch
  /** Internal JSON checkpoint, not a published report. */
  draft?: boolean
  onProgress?: (phase: 'preparing' | 'scanning' | 'baseline' | 'dynamic' | 'report') => Promise<void>
  view?: 'all' | 'new'; failOn?: 'none' | 'high' | 'medium'; signal: AbortSignal
  /** The user's saved exclusions. `identity` lets repair worktrees match the original repository. */
  suppressions?: SuppressionInput
  /** Repository identity to record when a repair worktree scans another path of the same repository. */
  identity?: string
  /** The task compares with its previous report but has none yet; the report says so instead of "no baseline". */
  firstScan?: boolean
}
export interface SuppressionInput { items: readonly Suppression[]; identity?: string; unavailable?: boolean }
/** An unreadable list must not block scanning; the report says that exclusions were not applied. */
export async function loadSuppressions(file: string): Promise<SuppressionInput> {
  try { return { items: await readSuppressions(file) } } catch { return { items: [], unavailable: true } }
}
async function analyze(source: Source, snapshot: Snapshot, options: AuditOptions): Promise<Pick<Report, 'findings' | 'engines' | 'coverage'>> {
  const binary = await executable(options.semgrepPath ?? 'semgrep', source.root)
  const raw = await scanWorkspace({ workspace: snapshot.path, mode: options.engine ?? 'auto', signal: options.signal,
    semgrepPath: binary ?? '/nonexistent/dsh-semgrep', ...(source.scope === 'full' ? {} : { files: source.changed }) }).catch(() => {
      options.signal.throwIfAborted()
      return { status: 'scanner-failed' as const, findings: [], coverage: { files: Object.keys(snapshot.files).filter(file => /\.(?:py|go|jsx?|tsx?|[mc]js)$/u.test(file) && (source.scope === 'full' || source.changed.includes(file))).length, skipped: { failed: 1 } } }
    })
  const findings = await Promise.all(raw.findings.map(item => enrich(snapshot, item)))
  const status = raw.status === 'completed' ? 'completed' : raw.status === 'partial' ? 'partial' : raw.status === 'scanner-unavailable' || raw.status === 'unsupported-scanner' ? 'unavailable' : raw.status === 'scanner-failed' ? 'failed' : options.engine === 'inventory' ? 'skipped' : 'completed'
  const engines: Report['engines'] = [{ name: 'semgrep', version: SEMGREP_VERSION, status,
    detail: 'Python / Go / JS / TS：' + Object.keys(RULES).length + ' 条包内规则（覆盖 Flask/Django、Express/React、net/http 等常见框架入口）。状态：' + raw.status + '；' + JSON.stringify(raw.coverage.skipped) }]
  if (options.secrets) { const result = await scanSecrets(snapshot, source.root, options.gitleaksPath ?? 'gitleaks', options.signal); engines.push(result.engine); findings.push(...result.findings) }
  else engines.push({ name: 'gitleaks', version: '', status: 'skipped', detail: '未启用密钥扫描。' })
  if (options.dependencies) { const result = await scanDependencies(snapshot, options.signal); engines.push(result.engine); findings.push(...result.findings) }
  else engines.push({ name: 'osv', version: '', status: 'skipped', detail: '未启用依赖数据库查询；没有发送依赖名称或版本。' })
  if (snapshot.limited) engines.push({ name: 'snapshot', version: '1', status: 'partial', detail: '快照存在未读取文件；以下为最多 40 个样例（不代表源码引擎必然未完成）：\n' + (snapshot.omissions?.slice(0, 40).map(item => item.file + '：' + item.reason).join('\n') || '目录项超过 20000 或存在不支持的 Git 条目。') })
  return { findings: findings.slice(0, 2000), engines, coverage: { files: raw.coverage.files, scannedFiles: 'scannedFiles' in raw ? raw.scannedFiles : 0,
    omittedFindings: Math.max(0, findings.length - 2000) + ('findingsOmitted' in raw ? raw.findingsOmitted : 0),
    detail: '源码扫描限于支持的语言和所选范围；依赖与密钥引擎启用时检查整份受限快照。规则命中需要复核；未检出不等于没有漏洞。' } }
}
// Runtime results are compared separately against the same URL, so they never decide static comparability.
const staticEngines = (report: Pick<Report, 'engines'>): Report['engines'] => report.engines.filter(engine => engine.name !== 'http')
const comparable = (report: Pick<Report, 'engines' | 'coverage'>): boolean => staticEngines(report).every(engine => ['completed', 'skipped'].includes(engine.status)) && staticEngines(report).some(engine => engine.status === 'completed') && report.coverage.omittedFindings === 0
export function compare(report: Report, baseline: Report, renames: Record<string, string> = {}): Report {
  const same = report.source.identity === baseline.source.identity && report.policy.rulesDigest === baseline.policy.rulesDigest &&
    report.policy.engine === baseline.policy.engine && report.policy.dependencies === baseline.policy.dependencies && report.policy.secrets === baseline.policy.secrets &&
    staticEngines(report).map(e => e.name + e.version).join() === staticEngines(baseline).map(e => e.name + e.version).join() &&
    (baseline.source.scope === 'full' || JSON.stringify(report.source.changed) === JSON.stringify(baseline.source.changed))
  const valid = same && comparable(report) && comparable(baseline)
  const remaining = [...baseline.findings.filter(item => item.engine !== 'llm' && item.engine !== 'http')]
  const findings = report.findings.map(item => {
    const position = remaining.findIndex(old => old.fingerprint === item.fingerprint && old.file === (renames[item.file] ?? item.file))
    if (position >= 0) { remaining.splice(position, 1); return { ...item, change: valid ? 'existing' as const : 'unknown' as const } }
    return { ...item, change: valid ? 'new' as const : 'unknown' as const }
  })
  const label = baseline.id.startsWith('git:') ? 'Git 基线 ' + baseline.id.slice(4, 16) : createdAtLabel(baseline.createdAt) + ' 的扫描报告'
  return { ...report, findings, baseline: { id: baseline.id, comparable: valid, reason: valid ? '对比 ' + label + '：使用相同规则和引擎，历史问题不重复计为新增；未检出问题不自动认定已修复。' : '无法完整对比 ' + label + '：仓库、范围、规则/引擎配置不同，或扫描不完整。新增状态保持未知。',
    notObserved: valid ? remaining.filter(item => report.source.scope === 'full' || report.source.changed.includes(item.file)).map(item => ({ ...item, change: 'not-observed' as const })) : [] } }
}
const createdAtLabel = (value: string): string => value.slice(0, 16).replace('T', ' ') + ' UTC'
export async function audit(options: AuditOptions): Promise<{ report: Report; json: string; html: string }> {
  if (options.baseline && options.base) throw new Error('Choose either --base for a Git baseline or --baseline for a saved report')
  await options.onProgress?.('preparing')
  const source = await prepareSource({ target: options.target, scope: options.scope ?? 'full', signal: options.signal,
    ...(options.url ? { url: options.url } : {}), ...(options.ref ? { ref: options.ref } : {}), ...(options.base ? { base: options.base } : {}) })
  try {
    const rulesDigest = hash(await readFile(new URL('../rules/baseline.yml', import.meta.url)))
    await options.onProgress?.('scanning')
    const results = await analyze(source, source.current, options)
    let report: Report = { schemaVersion: 1, pluginVersion: PLUGIN_VERSION, id: randomUUID(), createdAt: new Date().toISOString(),
      source: { identity: options.identity ?? source.identity, label: source.source, revision: source.scope === 'staged' ? 'index' : options.url || options.ref ? 'commit' : 'working-tree', scope: source.scope, digest: source.current.digest, files: source.current.files, changed: source.changed, skipped: source.current.skipped,
        ...(source.commit ? { commit: source.commit } : {}), ...(source.baseCommit ? { baseCommit: source.baseCommit } : {}) },
      policy: { engine: options.engine ?? 'auto', rulesDigest, dependencies: options.dependencies ?? false, secrets: options.secrets ?? false, view: options.view ?? 'all', failOn: options.failOn ?? 'none' },
      ...results, reviews: [], notes: ['报告保存扫描依据、位置和限量脱敏代码片段；密钥检测命中的文件不导出原文。', 'LLM 复核尚未执行；使用 dsh-security-review 并保存复核结果后会生成新报告版本。', '文件名变化仅在内容完全相同时自动识别；重命名并修改的候选需人工确认是否历史问题。', '本地 Git 工作区遵循 .gitignore 等标准忽略规则；已跟踪文件仍纳入检查。', '未启用项目自带脚本、Git hooks、子模块或依赖安装。'] }
    const savedBaseline = options.baseline ? await readReport(options.baseline) : undefined
    if (savedBaseline) report = compare(report, savedBaseline, source.renames)
    else if (source.previous) {
      await options.onProgress?.('baseline')
      const baseline: Report = { ...report, id: 'git:' + source.baseCommit, source: { ...report.source, digest: source.previous.digest, files: source.previous.files }, ...await analyze(source, source.previous, options) }
      report = compare(report, baseline, source.renames)
    } else if (source.scope === 'staged' && !source.commit) report = { ...report, findings: report.findings.map(item => ({ ...item, change: comparable(report) ? 'new' : 'unknown' })), notes: [...report.notes, '首次提交，无历史基线；暂存区发现视为新增候选。'] }
    // The coverage section shows this reason in place of "no baseline"; nothing is compared.
    else if (options.firstScan) report = { ...report, baseline: { id: 'first-scan', comparable: false, reason: '这是该任务第一次完成扫描，没有上一份报告可对比，新增状态为未比较；下次扫描会自动以本报告为基线。', notObserved: [] } }
    report.evidenceArchive = await captureScanEvidence(report, source.current.path)
    if (options.dynamicUrl) {
      await options.onProgress?.('dynamic')
      const dynamic = await scanDynamic(options.dynamicUrl, options.signal, options.fetcher)
      report = mergeDynamic({ ...report, policy: { ...report.policy, dynamic: dynamic.target } }, dynamic, savedBaseline)
      report.notes = [...report.notes, '运行时基线检查只对用户授权的地址发送固定的同源 GET 请求，不发送攻击载荷、不登录，报告不保存响应正文或 Cookie 值；不是完整 DAST。']
    }
    if (options.suppressions?.items.length) report = applySuppressions(report, options.suppressions.items, options.suppressions.identity ?? report.source.identity)
    if (options.suppressions?.unavailable) report.notes = [...report.notes, '排除记录无法读取，本次未应用你之前的排除决定；请检查 suppressions.json 的权限和格式。']
    if (!options.draft) await options.onProgress?.('report')
    return { report, ...await writeReport(options.output ?? defaultReportsRoot(), report, options.draft) }
  } finally { await source.dispose() }
}
