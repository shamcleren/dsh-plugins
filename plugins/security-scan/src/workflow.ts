import { captureScanEvidence } from './report-evidence.js'
import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { scanWorkspace, executable, SEMGREP_VERSION } from './scanner.js'
import { prepareSource, hash, type Scope, type Source, type Snapshot } from './repository.js'
import { enrich, scanDependencies, scanSecrets } from './engines.js'
import { PLUGIN_VERSION, readReport, writeReport, defaultReportsRoot, type Report, type Finding } from './report.js'

export interface AuditOptions {
  target: string; url?: string; ref?: string; scope?: Scope; base?: string; baseline?: string; output?: string
  engine?: 'auto' | 'semgrep' | 'inventory'; semgrepPath?: string; gitleaksPath?: string; dependencies?: boolean; secrets?: boolean
  /** Internal JSON checkpoint, not a published report. */
  draft?: boolean
  onProgress?: (phase: 'preparing' | 'scanning' | 'baseline' | 'report') => Promise<void>
  view?: 'all' | 'new'; failOn?: 'none' | 'high' | 'medium'; signal: AbortSignal
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
    detail: 'Python / Go / JS / TS：12 类包内基础规则。状态：' + raw.status + '；' + JSON.stringify(raw.coverage.skipped) }]
  if (options.secrets) { const result = await scanSecrets(snapshot, source.root, options.gitleaksPath ?? 'gitleaks', options.signal); engines.push(result.engine); findings.push(...result.findings) }
  else engines.push({ name: 'gitleaks', version: '', status: 'skipped', detail: '未启用密钥扫描。' })
  if (options.dependencies) { const result = await scanDependencies(snapshot, options.signal); engines.push(result.engine); findings.push(...result.findings) }
  else engines.push({ name: 'osv', version: '', status: 'skipped', detail: '未启用依赖数据库查询；没有发送依赖名称或版本。' })
  if (snapshot.limited) engines.push({ name: 'snapshot', version: '1', status: 'partial', detail: '快照存在未读取文件；以下为最多 40 个样例（不代表源码引擎必然未完成）：\n' + (snapshot.omissions?.slice(0, 40).map(item => item.file + '：' + item.reason).join('\n') || '目录项超过 20000 或存在不支持的 Git 条目。') })
  return { findings: findings.slice(0, 2000), engines, coverage: { files: raw.coverage.files, scannedFiles: 'scannedFiles' in raw ? raw.scannedFiles : 0,
    omittedFindings: Math.max(0, findings.length - 2000) + ('findingsOmitted' in raw ? raw.findingsOmitted : 0),
    detail: '源码扫描限于支持的语言和所选范围；依赖与密钥引擎启用时检查整份受限快照。规则命中需要复核；未检出不等于没有漏洞。' } }
}
const comparable = (report: Pick<Report, 'engines' | 'coverage'>): boolean => report.engines.every(engine => ['completed', 'skipped'].includes(engine.status)) && report.engines.some(engine => engine.status === 'completed') && report.coverage.omittedFindings === 0
export function compare(report: Report, baseline: Report, renames: Record<string, string> = {}): Report {
  const same = report.source.identity === baseline.source.identity && report.policy.rulesDigest === baseline.policy.rulesDigest &&
    report.policy.engine === baseline.policy.engine && report.policy.dependencies === baseline.policy.dependencies && report.policy.secrets === baseline.policy.secrets &&
    report.engines.map(e => e.name + e.version).join() === baseline.engines.map(e => e.name + e.version).join() &&
    (baseline.source.scope === 'full' || JSON.stringify(report.source.changed) === JSON.stringify(baseline.source.changed))
  const valid = same && comparable(report) && comparable(baseline)
  const remaining = [...baseline.findings.filter(item => item.engine !== 'llm')]
  const findings = report.findings.map(item => {
    const position = remaining.findIndex(old => old.fingerprint === item.fingerprint && old.file === (renames[item.file] ?? item.file))
    if (position >= 0) { remaining.splice(position, 1); return { ...item, change: valid ? 'existing' as const : 'unknown' as const } }
    return { ...item, change: valid ? 'new' as const : 'unknown' as const }
  })
  return { ...report, findings, baseline: { id: baseline.id, comparable: valid, reason: valid ? '使用相同规则和引擎比较基线。历史问题不重复计为新增；未检出问题不自动认定已修复。' : '基线不可完整比较：仓库、范围、规则/引擎配置不同，或扫描不完整。新增状态保持未知。',
    notObserved: valid ? remaining.filter(item => report.source.scope === 'full' || report.source.changed.includes(item.file)).map(item => ({ ...item, change: 'not-observed' as const })) : [] } }
}
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
      source: { identity: source.identity, label: source.source, revision: source.scope === 'staged' ? 'index' : options.url || options.ref ? 'commit' : 'working-tree', scope: source.scope, digest: source.current.digest, files: source.current.files, changed: source.changed, skipped: source.current.skipped,
        ...(source.commit ? { commit: source.commit } : {}), ...(source.baseCommit ? { baseCommit: source.baseCommit } : {}) },
      policy: { engine: options.engine ?? 'auto', rulesDigest, dependencies: options.dependencies ?? false, secrets: options.secrets ?? false, view: options.view ?? 'all', failOn: options.failOn ?? 'none' },
      ...results, reviews: [], notes: ['报告保存扫描依据、位置和限量脱敏代码片段；密钥检测命中的文件不导出原文。', 'LLM 复核尚未执行；使用 security-review 并保存复核结果后会生成新报告版本。', '文件名变化仅在内容完全相同时自动识别；重命名并修改的候选需人工确认是否历史问题。', '本地 Git 工作区遵循 .gitignore 等标准忽略规则；已跟踪文件仍纳入检查。', '未启用项目自带脚本、Git hooks、子模块或依赖安装。'] }
    if (options.baseline) report = compare(report, await readReport(options.baseline), source.renames)
    else if (source.previous) {
      await options.onProgress?.('baseline')
      const baseline: Report = { ...report, id: 'git:' + source.baseCommit, source: { ...report.source, digest: source.previous.digest, files: source.previous.files }, ...await analyze(source, source.previous, options) }
      report = compare(report, baseline, source.renames)
    } else if (source.scope === 'staged' && !source.commit) report = { ...report, findings: report.findings.map(item => ({ ...item, change: comparable(report) ? 'new' : 'unknown' })), notes: [...report.notes, '首次提交，无历史基线；暂存区发现视为新增候选。'] }
    report.evidenceArchive = await captureScanEvidence(report, source.current.path)
    if (!options.draft) await options.onProgress?.('report')
    return { report, ...await writeReport(options.output ?? defaultReportsRoot(), report, options.draft) }
  } finally { await source.dispose() }
}
