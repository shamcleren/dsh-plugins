import { planRepair, prepareRepairWorkspace, previewRepair, validateRepairWorkspace, validateRepairUrl } from './repair-workspace.js'
import { compareFollowUp, findingItem, repairPrompt, startRepair } from './follow-up.js'
import type { SessionRequestId } from '@deepseek-ai/dsh-api-session-controller'
import { readEvidence } from './evidence.js'
import { zh } from './client/locales.js'
import { SessionId } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-workspace'
import type {} from '@deepseek-ai/dsh-api-session-controller'
import type { ScanSession } from './session.js'
import type { Toolchains } from './toolchains.js'
import { randomUUID } from 'node:crypto'
import { lstat, mkdir, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises'
import { acquirePidLock } from './lock.js'
import type { FileHandle } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { z } from 'zod'
import { runAgentReview, type AgentReviewOptions } from './agent.js'
import { audit, loadSuppressions, type AuditOptions } from './workflow.js'
import { addSuppressions, readSuppressions, removeSuppression, suppressionFor, SuppressionError } from './suppressions.js'
import { stageReportDeletion, exitCode, listReports, readReport, renderReport, reportFile, reviewReport, writeReport, type Finding } from './report.js'
import { manageHook, AuditQueue } from './hooks.js'
import { validateRepositoryUrl, inside } from './repository.js'
import { RepairRequestSchema, type ReportActions, HookRequestSchema, RunSchema, SettingsSchema, TaskConfigSchema, TaskSchema, type Task, type TaskConfig, type Run, type ScanSettings, type UiState, type HookRequest, type ModelCatalog, type Suppression } from './ui-contract.js'

export class TaskError extends Error { constructor(readonly code: string) { super(code) } }
const acquireTaskLock = (root: string): Promise<FileHandle> => acquirePidLock(join(root, '.tasks.lock'), join(root, '.tasks-recovery.lock'), () => new TaskError('task-store-locked'))
const StoreSchema = z.object({ owner: z.literal('dsh-security-tasks-v1'), tasks: z.array(TaskSchema).max(100), runs: z.array(RunSchema).max(100) }).strict()
type Store = z.infer<typeof StoreSchema>
interface Options {
  models?(): Promise<ModelCatalog>
  reportLink?(id: string): string | undefined
  session?(): ScanSession | undefined
  toolchains?: Toolchains
  root: string; settings(): ScanSettings; writable(): boolean; updateSettings(value: ScanSettings): Promise<void>
  audit?: typeof audit; hook?: typeof manageHook; log(error: unknown): void
  agentContext?(): Pick<AgentReviewOptions, 'native' | 'selection' | 'preset' | 'keepSession'>
}
const active = (run: Run): boolean => ['queued', 'running', 'cancelling'].includes(run.status)
/** Persistent human-operated tasks, with one owned scan and bounded queued work. */
export class SecurityTasks {
  private data: Store = { owner: 'dsh-security-tasks-v1', tasks: [], runs: [] }
  private tail = Promise.resolve()
  private runner: Promise<void> | undefined
  private abort: AbortController | undefined
  private runningId: string | undefined
  private readonly repairs = new Map<string, Promise<{ sessionId: string }>>()
  private readonly publishingReports = new Set<string>()
  private closed = false
  private closing = false
  private runnerFailed = false
  private readonly dirtyTasks = new Set<string>()
  private readonly hookControllers = new Set<AbortController>()
  private readonly ownedOperations = new Set<Promise<unknown>>()
  private suppressionTail: Promise<unknown> = Promise.resolve()
  private readonly queue: AuditQueue
  private constructor(private readonly options: Options, private readonly lock: FileHandle) {
    this.queue = new AuditQueue(async id => {
      const task = this.data.tasks.find(task => task.id === id)
      if (task?.config.autoScan) await this.start(task.id, task.revision, 'edit')
    }, () => options.log(new TaskError('auto-scan-failed')))
  }
  static async open(options: Options): Promise<SecurityTasks> {
    await mkdir(options.root, { recursive: true, mode: 0o700 })
    if ((await lstat(options.root)).isSymbolicLink()) throw new TaskError('unsafe-storage')
    const lock = await acquireTaskLock(options.root)
    const service = new SecurityTasks(options, lock)
    try {
      await lock.writeFile(String(process.pid) + '\n')
      try {
        const path = join(options.root, 'tasks.json'), stat = await lstat(path)
        if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 4 * 1024 * 1024) throw new TaskError('unsafe-storage')
        service.data = StoreSchema.parse(JSON.parse(await readFile(path, 'utf8')))
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
      for (const run of service.data.runs) if (active(run)) Object.assign(run, { status: 'interrupted', phase: 'finished', finishedAt: new Date().toISOString(), error: 'host-restarted' })
      await service.persist(); return service
    } catch (error) { await lock.close(); await rm(join(options.root, '.tasks.lock')); throw error }
  }
  private async persist(): Promise<void> {
    const next = join(this.options.root, '.tasks-' + randomUUID() + '.json')
    let document = JSON.stringify(StoreSchema.parse(this.data), null, 2) + '\n'
    // Keep the writer's bound equal to the reader's; large AI histories must not make restart impossible.
    while (Buffer.byteLength(document) > 4 * 1024 * 1024) {
      const index = this.data.runs.findIndex(run => !active(run) && !(run.reportId && this.repairs.has(run.reportId)))
      if (index < 0) throw new TaskError('task-store-full')
      this.data.runs.splice(index, 1)
      document = JSON.stringify(this.data, null, 2) + '\n'
    }
    try { await writeFile(next, document, { flag: 'wx', mode: 0o600 }); await rename(next, join(this.options.root, 'tasks.json')) }
    finally { await rm(next, { force: true }) }
  }
  private mutate<T>(operation: () => Promise<T> | T): Promise<T> {
    const task = this.tail.then(async () => {
      if (this.closed) throw new TaskError('service-stopped')
      const previous = structuredClone(this.data)
      try { const result = await operation(); await this.persist(); return structuredClone(result) }
      catch (error) { this.data = previous; throw error }
    })
    this.tail = task.then(() => {}, () => {})
    return task
  }
  private assertOpen(): void { if (this.closed || this.closing) throw new TaskError('service-stopped') }
  private task(id: string, revision: number): Task {
    const task = this.data.tasks.find(task => task.id === id)
    if (!task) throw new TaskError('task-not-found')
    if (task.revision !== revision) throw new TaskError('task-changed')
    return task
  }
  async models(): Promise<ModelCatalog> {
    this.assertOpen()
    return this.options.models ? this.options.models() : { models: [], partial: true }
  }
  async state(): Promise<UiState> {
    await this.tail
    const warnings: string[] = []
    const selection = this.options.agentContext?.().selection
    const reports = await listReports(this.options.settings().reportDirectory).catch(() => { warnings.push('report-directory-unavailable'); return [] })
    return structuredClone({ tasks: this.data.tasks, runs: [...this.data.runs].reverse(), reports, settings: this.options.settings(), settingsWritable: this.options.writable(), agentDefault: selection ? { provider: selection.provider, model: selection.model } : null, warnings, ...(this.options.toolchains ? { toolchains: this.options.toolchains.state() } : {}) })
  }
  setup(): void { this.assertOpen(); void this.options.toolchains?.setup().catch(error => this.options.log(error)) }
  private async validated(input: TaskConfig): Promise<TaskConfig> {
    const config = TaskConfigSchema.parse(input)
    if (config.kind === 'remote') config.target = validateRepositoryUrl(config.target)
    else {
      if (!isAbsolute(config.target)) throw new TaskError('absolute-path-required')
      const target = await realpath(config.target)
      if (!(await lstat(target)).isDirectory() || target === '/' || target === homedir()) throw new TaskError('code-directory-required')
      config.target = target
    }
    return config
  }
  async save(input: TaskConfig, id?: string, revision?: number): Promise<Task> {
    this.assertOpen()
    const config = await this.validated(input)
    return this.mutate(() => {
      const previous = id ? this.task(id, revision ?? 0) : undefined
      if (!previous && this.data.tasks.length >= 100) throw new TaskError('task-limit')
      // A workbench edit makes a conversation-created task the user's own; later conversation scans no longer overwrite it.
      const task: Task = { id: previous?.id ?? randomUUID(), revision: (previous?.revision ?? 0) + 1, updatedAt: new Date().toISOString(), config }
      this.data.tasks = [...this.data.tasks.filter(value => value.id !== task.id), task]; return task
    })
  }
  /**
   * Conversation scans reuse one task per source and scope, so repeated requests share run history
   * and the previous-report baseline. Workbench tasks belong to the user and are never reused.
   */
  async saveConversation(input: TaskConfig): Promise<Task> {
    this.assertOpen()
    const config = await this.validated(input)
    const key = (value: TaskConfig) => JSON.stringify([value.kind, value.target, value.ref, value.scope, value.base])
    return this.mutate(() => {
      const previous = this.data.tasks.find(task => task.origin === 'conversation' && key(task.config) === key(config))
      if (!previous && this.data.tasks.length >= 100) throw new TaskError('task-limit')
      const task: Task = { id: previous?.id ?? randomUUID(), revision: (previous?.revision ?? 0) + 1, updatedAt: new Date().toISOString(), origin: 'conversation', config }
      this.data.tasks = [...this.data.tasks.filter(value => value.id !== task.id), task]; return task
    })
  }
  /**
   * The task's newest readable report from a successful run, preferring complete coverage. Repair-branch
   * rescans scan other code and are skipped. Undefined means this is the task's first comparable scan.
   */
  private async previousReport(taskId: string): Promise<string | undefined> {
    const candidates = this.data.runs.filter(run => run.taskId === taskId && run.status === 'succeeded' && run.reportId && !run.repairSource).reverse().slice(0, 10)
    let fallback: string | undefined
    for (const run of candidates) {
      try { await readReport(this.reportLocation(run.reportId!)) }
      catch { continue /* A deleted or unreadable report is skipped; an older one may still serve. */ }
      if (run.coverage !== 'partial') return run.reportId
      fallback ??= run.reportId
    }
    return fallback
  }
  async remove(id: string, revision: number): Promise<void> {
    this.assertOpen()
    await this.mutate(() => {
      this.task(id, revision)
      if (this.data.runs.some(run => run.taskId === id && active(run))) throw new TaskError('task-busy')
      this.data.tasks = this.data.tasks.filter(task => task.id !== id)
    })
  }
  async removeRun(id: string): Promise<void> {
    this.assertOpen()
    z.string().uuid().parse(id)
    await this.mutate(() => {
      const run = this.data.runs.find(run => run.id === id)
      if (!run) throw new TaskError('run-not-found')
      if (active(run) || this.runningId === id || (run.reportId && this.repairs.has(run.reportId))) throw new TaskError('run-busy')
      this.data.runs = this.data.runs.filter(run => run.id !== id)
    })
  }
  async removeReport(id: string): Promise<void> {
    this.assertOpen()
    z.string().uuid().parse(id)
    // Serialize baseline checks, filesystem staging and store updates against task starts/settings.
    const operation = this.tail.then(async () => {
      this.assertOpen()
      if (this.repairs.has(id) || this.publishingReports.has(id)
        || this.data.runs.some(run => (active(run) || run.id === this.runningId) && (run.previousReportId === id || run.baselineReportId === id || run.reportId === id || run.rulesReportId === id))) throw new TaskError('report-in-use')
      let staged: Awaited<ReturnType<typeof stageReportDeletion>>
      try { staged = await stageReportDeletion(this.reportLocation(id), id) }
      catch (error) { throw new TaskError((error as NodeJS.ErrnoException).code === 'ENOENT' ? 'report-not-found' : 'unsafe-report-delete') }
      const previous = structuredClone(this.data)
      try {
        for (const run of this.data.runs) {
          if (run.previousReportId === id) { delete run.previousReportId; delete run.previousReportRoot }
          if (run.reportId === id) delete run.reportId
          if (run.rulesReportId === id) delete run.rulesReportId
        }
        await this.persist()
      } catch (error) { this.data = previous; await staged.restore(); throw error }
      await staged.finish()
    })
    this.tail = operation.then(() => {}, () => {})
    return operation
  }
  async start(id: string, revision: number, trigger: Run['trigger'] = 'manual', sessionId?: string): Promise<Run> {
    this.assertOpen()
    const run = await this.mutate(async () => {
      const task = this.task(id, revision)
      if (this.data.runs.some(run => active(run) && (run.taskId === id || (sessionId && run.originSessionId === sessionId)))) throw new TaskError('task-busy')
      if (this.data.runs.filter(active).length >= 10) throw new TaskError('queue-full')
      // Resolved once at queue time, so the run compares with a fixed report even if newer runs finish first.
      const baselineReportId = task.config.baseline === 'previous' ? await this.previousReport(id) : undefined
      const run: Run = { id: randomUUID(), taskId: id, config: structuredClone(task.config), status: 'queued', phase: 'queued', trigger, ...(sessionId ? { originSessionId: sessionId, sessionId } : {}), ...(baselineReportId ? { baselineReportId } : {}), createdAt: new Date().toISOString() }
      this.data.runs.push(run)
      while (this.data.runs.length > 100) { const index = this.data.runs.findIndex(item => !active(item) && !(item.reportId && this.repairs.has(item.reportId))); if (index < 0) throw new TaskError('queue-full'); this.data.runs.splice(index, 1) }
      return run
    })
    this.runnerFailed = false; this.kick(); return run
  }
  async rescan(reportId: string, trigger: 'manual' | 'repair' = 'manual', session?: string): Promise<Run> {
    this.assertOpen()
    z.string().uuid().parse(reportId)
    const run = await this.mutate(async () => {
      const previous = this.data.runs.find(item => item.reportId === reportId)
      if (!previous) throw new TaskError('run-not-found')
      if (this.data.runs.some(item => active(item) && item.taskId === previous.taskId)) throw new TaskError('task-busy')
      if (this.data.runs.filter(active).length >= 10) throw new TaskError('queue-full')
      await readReport(this.reportLocation(reportId))
      const config = structuredClone(previous.config)
      const repairSource = previous.repair?.mode === 'pr' ? previous.repair.workspace : previous.repairSource
      if (repairSource) {
        await validateRepairWorkspace(repairSource, AbortSignal.timeout(5000))
        config.target = repairSource.target; config.ref = ''
      }
      const run: Run = { id: randomUUID(), taskId: previous.taskId, config, ...(repairSource ? { repairSource: structuredClone(repairSource) } : {}),
        // A rescan's previous report is the one it verifies.
        ...(config.baseline === 'previous' ? { baselineReportId: reportId } : {}),
        previousReportId: reportId, previousReportRoot: previous.reportRoot ?? this.options.settings().reportDirectory,
        ...(trigger === 'repair' && session ? { repairSessionId: session } : {}),
        status: 'queued', phase: 'queued', trigger, createdAt: new Date().toISOString() }
      this.data.runs.push(run)
      while (this.data.runs.length > 100) { const index = this.data.runs.findIndex(item => !active(item) && !(item.reportId && this.repairs.has(item.reportId))); if (index < 0) throw new TaskError('queue-full'); this.data.runs.splice(index, 1) }
      return run
    })
    this.runnerFailed = false; this.kick(); return run
  }
  async reportActions(id: string): Promise<ReportActions> {
    await this.tail
    const report = await readReport(this.reportLocation(id))
    const run = this.data.runs.find(item => item.reportId === id)
    const saved = suppressionFor(await readSuppressions(this.suppressionFile).catch(() => []), report.source.identity)
    const excluded = new Set(report.findings.filter(item => item.suppression || saved(item)).map(item => item.id))
    const compared = run?.previousReportId ? compareFollowUp(await readReport(reportFile(run.previousReportRoot ?? this.options.settings().reportDirectory, run.previousReportId)), report) : undefined
    // Exclusions saved after the rescan apply to its comparison too, so they are not offered for another round.
    const comparison = compared && { ...compared, items: compared.items.map(item => item.change !== 'notObserved' && excluded.has(item.id) ? { ...item, suppressed: true } : item) }
    let prPreview, prError
    if (run && !run.repair && run.config.kind === 'local') {
      this.assertOpen()
      const operation = previewRepair(run.config.target, AbortSignal.timeout(5000))
      this.ownedOperations.add(operation)
      try { const { repositoryUrl, base, commit, revision } = await operation; prPreview = { repositoryUrl, base, commit, revision } }
      catch (error) { prError = error instanceof Error && error.message.startsWith('repair-pr-') ? error.message : 'repair-pr-repository' }
      finally { this.ownedOperations.delete(operation) }
    }
    const parent = run?.previousReportId && !run.repair ? this.data.runs.find(item => item.reportId === run.previousReportId) : undefined
    const chain = parent ? this.repairOrigin(parent) : undefined
    return structuredClone({ findings: report.findings.map(item => findingItem(item, excluded.has(item.id))), ...(run ? { run } : {}), ...(chain ? { repairChain: { sessionId: chain.origin.repair!.sessionId, round: chain.round + 1 } } : {}),
      repairMode: run?.repair?.mode ?? this.data.tasks.find(task => task.id === run?.taskId)?.config.repairMode ?? 'pr', ...(prPreview ? { prPreview } : {}), ...(prError ? { prError } : {}),
      repairable: !!run && run.config.kind === 'local' && !run.config.ref && run.config.scope !== 'staged' && report.source.revision === 'working-tree' && !active(run),
      ...(comparison ? { comparison } : {}) })
  }
  repair(id: string, findingIds: string[], mode: 'pr' | 'local', expectedRevision?: string): Promise<{ sessionId: string }> {
    this.assertOpen()
    const request = RepairRequestSchema.parse({ id, findingIds, mode, expectedRevision })
    const existing = this.repairs.get(id)
    if (existing) return existing.then(result => {
      const repair = this.data.runs.find(run => run.reportId === id)?.repair
      if (!repair || repair.mode !== request.mode || JSON.stringify([...repair.findingIds].sort()) !== JSON.stringify([...request.findingIds].sort())) throw new TaskError('repair-exists')
      return result
    })
    const controller = new AbortController()
    this.hookControllers.add(controller)
    const operation = (async () => {
      const native = this.options.agentContext?.().native
      if (!native) throw new TaskError('scan-session-unavailable')
      const { run, report } = await this.mutate(async () => {
        const run = this.data.runs.find(item => item.reportId === id)
        const report = await readReport(this.reportLocation(id))
        if (!run || run.config.kind !== 'local' || run.config.ref || run.config.scope === 'staged' || report.source.revision !== 'working-tree' || active(run)) throw new TaskError('repair-unavailable')
        if (await realpath(run.config.target) !== run.config.target || !(await lstat(run.config.target)).isDirectory()) throw new TaskError('repair-unavailable')
        if (new Set(request.findingIds).size !== request.findingIds.length || request.findingIds.some(key => !report.findings.some(item => item.id === key && item.status !== 'dismissed'))) throw new TaskError('unknown-finding')
        if (run.repair && (run.repair.mode !== request.mode || JSON.stringify([...run.repair.findingIds].sort()) !== JSON.stringify([...request.findingIds].sort()))) throw new TaskError('repair-exists')
        if (!run.repair) {
          const requestId = randomUUID()
          let workspace
          if (request.mode === 'pr') {
            try { workspace = await planRepair(run.config.target, this.options.root, requestId, report.source.identity, request.expectedRevision, controller.signal) }
            catch (error) { throw new TaskError(error instanceof Error && error.message.startsWith('repair-pr-') ? error.message : 'repair-pr-repository') }
          }
          run.repair = { requestId, mode: request.mode, ...(workspace ? { workspace } : {}), sessionId: 'security-repair-' + requestId, findingIds: request.findingIds }
          const task = this.data.tasks.find(task => task.id === run.taskId)
          if (task && task.config.repairMode !== request.mode) { task.config.repairMode = request.mode; task.revision++; task.updatedAt = new Date().toISOString() }
        }
        return { run, report }
      })
      if (run.repair!.mode === 'pr') {
        if (!run.repair!.workspace) throw new TaskError('repair-pr-worktree')
        try { await prepareRepairWorkspace(run.repair!.workspace, this.options.root, run.repair!.requestId, controller.signal) }
        catch (error) { throw new TaskError(error instanceof Error && error.message.startsWith('repair-pr-') ? error.message : 'repair-pr-worktree') }
      }
      if (run.repair!.admitted) return { sessionId: run.repair!.sessionId }
      const sessionId = await startRepair(native, run, report, controller.signal, this.options.reportLink?.(id))
      await this.mutate(() => { this.data.runs.find(item => item.id === run.id)!.repair!.admitted = true })
      return { sessionId }
    })()
    const owned = operation.finally(() => { this.repairs.delete(id); this.ownedOperations.delete(owned); this.hookControllers.delete(controller) })
    this.repairs.set(id, owned); this.ownedOperations.add(owned)
    return owned
  }
  private latestRescan(reportId: string): Run | undefined { return this.data.runs.filter(run => run.previousReportId === reportId && run.reportId).at(-1) }
  /** The repair that owns a report: the run itself, or the nearest ancestor through rescans. */
  private repairOrigin(run: Run): { origin: Run; round: number } | undefined {
    let current: Run | undefined = run, round = 1
    while (current && !current.repair) { const parent: string | undefined = current.previousReportId; current = parent ? this.data.runs.find(item => item.reportId === parent) : undefined; round++ }
    return current?.repair?.admitted ? { origin: current, round } : undefined
  }
  /** Reports owned by one admitted repair session, oldest first: the repaired report and its rescans. */
  private repairReports(sessionId: string): Run[] | undefined {
    const origin = this.data.runs.find(run => run.repair?.sessionId === sessionId && run.repair.admitted)
    if (!origin?.reportId) return undefined
    const chain = [origin]
    for (let next = this.latestRescan(origin.reportId); next; next = this.latestRescan(next.reportId!)) chain.push(next)
    return chain
  }
  /**
   * Reports a conversation may act on, newest first: its repair chain, scans it started or observed, or an
   * explicitly named report of a local scan inside its workspace. Other conversations' reports stay out of reach.
   */
  private async sessionReports(sessionId: string, workspace: string | undefined, reportId?: string): Promise<string[]> {
    const chain = this.repairReports(sessionId)?.map(run => run.reportId!).reverse()
    const owned = chain ?? this.data.runs.filter(run => run.reportId && [run.sessionId, run.originSessionId, run.repairSessionId].includes(sessionId)).map(run => run.reportId!).reverse()
    if (!reportId) return owned.slice(0, 5)
    if (owned.includes(reportId)) return [reportId]
    const run = this.data.runs.find(item => item.reportId === reportId)
    if (run && workspace && run.config.kind === 'local') {
      try { if (inside(await realpath(workspace), await realpath(run.config.target))) return [reportId] } catch { /* A moved target cannot prove workspace ownership. */ }
    }
    throw new TaskError('report-not-found')
  }
  /** Resolve finding IDs to the newest reachable report containing each, for preview and exclusion. */
  async exclusionTargets(sessionId: string, workspace: string | undefined, findingIds: string[], reportId?: string): Promise<Array<{ reportId: string; finding: Finding }>> {
    this.assertOpen()
    await this.tail
    const ids = z.array(z.string().min(1).max(200)).min(1).max(20).parse(findingIds)
    if (new Set(ids).size !== ids.length) throw new TaskError('unknown-finding')
    const candidates = await this.sessionReports(sessionId, workspace, reportId)
    if (!candidates.length) throw new TaskError('report-not-found')
    const reports = await Promise.all(candidates.map(async id => ({ reportId: id, report: await readReport(this.reportLocation(id)) })))
    return ids.map(id => {
      for (const { reportId: owner, report } of reports) {
        const finding = report.findings.find(item => item.id === id && item.status !== 'dismissed')
        if (!finding) continue
        if (finding.engine === 'llm') throw new TaskError('finding-not-suppressible')
        return { reportId: owner, finding }
      }
      throw new TaskError('unknown-finding')
    })
  }
  /** Actionable findings of a report for the conversation that owns it: not dismissed and not excluded by the user. */
  async reportFindings(sessionId: string, workspace: string | undefined, requested?: string): Promise<{ reportId: string; total: number; items: ReturnType<typeof findingItem>[] }> {
    this.assertOpen()
    await this.tail
    const [reportId] = await this.sessionReports(sessionId, workspace, requested)
    if (!reportId) throw new TaskError('report-not-found')
    const report = await readReport(this.reportLocation(reportId))
    const saved = suppressionFor(await readSuppressions(this.suppressionFile).catch(() => []), report.source.identity)
    const actionable = report.findings.filter(item => item.status !== 'dismissed' && !saved(item))
    return { reportId, total: actionable.length, items: actionable.slice(0, 50).map(item => findingItem(item)) }
  }
  /** Record findings a conversation verified as not worth fixing; the tool layer obtains the user's approval first. */
  async excludeFromSession(sessionId: string, workspace: string | undefined, findingIds: string[], reason: string, reportId?: string): Promise<{ added: number; existing: number }> {
    const resolved = await this.exclusionTargets(sessionId, workspace, findingIds, reportId)
    let added = 0, existing = 0
    for (const owner of new Set(resolved.map(item => item.reportId))) {
      const result = await this.suppress(owner, resolved.filter(item => item.reportId === owner).map(item => item.finding.id), reason)
      added += result.added; existing += result.existing
    }
    return { added, existing }
  }
  /** Called from the repair session itself; rescans the newest report in that repair chain. */
  async repairRescan(sessionId: string): Promise<Run> {
    this.assertOpen()
    await this.tail
    const chain = this.repairReports(sessionId)
    if (!chain) throw new TaskError('repair-unavailable')
    const origin = chain[0]!, latest = chain.at(-1)!
    const pending = this.data.runs.find(run => run.taskId === origin.taskId && active(run))
    if (pending && pending.previousReportId === latest.reportId) return structuredClone(pending)
    return this.rescan(latest.reportId!, 'repair', sessionId)
  }
  /** Queue remaining and newly added findings from a rescan comparison into the original repair session. */
  async continueRepair(reportId: string): Promise<{ sessionId: string; count: number }> {
    this.assertOpen()
    z.string().uuid().parse(reportId)
    const native = this.options.agentContext?.().native
    if (!native) throw new TaskError('scan-session-unavailable')
    await this.tail
    const run = this.data.runs.find(item => item.reportId === reportId)
    const parent = run?.previousReportId ? this.data.runs.find(item => item.reportId === run.previousReportId) : undefined
    const chain = parent && !run?.repair ? this.repairOrigin(parent) : undefined
    if (!run || !chain || active(run)) throw new TaskError('repair-unavailable')
    const { origin } = chain, round = chain.round + 1
    const [previous, report, first] = await Promise.all([readReport(reportFile(run.previousReportRoot ?? this.options.settings().reportDirectory, run.previousReportId!)), readReport(this.reportLocation(reportId)), readReport(reportFile(origin.reportRoot ?? this.options.settings().reportDirectory, origin.reportId!))])
    const comparison = compareFollowUp(previous, report)
    // Fingerprints are stable across rescans; IDs are not. Newly added issues are always offered.
    const scope = new Set(first.findings.filter(item => origin.repair!.findingIds.includes(item.id)).map(item => item.fingerprint))
    const added = new Set(comparison.comparable ? comparison.items.filter(item => item.change === 'added').map(item => item.id) : [])
    const saved = suppressionFor(await readSuppressions(this.suppressionFile).catch(() => []), report.source.identity)
    const findings = report.findings.filter(item => item.status !== 'dismissed' && !saved(item) && (scope.has(item.fingerprint) || added.has(item.id))).slice(0, 20)
    if (!findings.length) throw new TaskError('nothing-to-repair')
    const sessionId = origin.repair!.sessionId
    await native.sessionController.prompt({ sessionId: SessionId(sessionId), requestId: randomUUID() as SessionRequestId, mode: 'queue', content: [{ type: 'text', text: repairPrompt(report, findings, this.options.reportLink?.(reportId), origin.repair, round) }] }, AbortSignal.timeout(30_000))
    return { sessionId, count: findings.length }
  }
  async recordRepairDelivery(sessionId: string, url: string): Promise<void> {
    this.assertOpen()
    await this.mutate(() => {
      const repair = this.data.runs.find(run => run.repair?.sessionId === sessionId)?.repair
      if (repair?.mode !== 'pr' || !repair.workspace || !repair.admitted) throw new TaskError('repair-unavailable')
      try { repair.workspace.prUrl = validateRepairUrl(repair.workspace, url) }
      catch { throw new TaskError('repair-pr-url') }
    })
  }
  private kick(): void {
    if (this.runner || this.closed || this.closing || this.runnerFailed) return
    this.runner = this.drain().catch(error => {
      this.runnerFailed = true; this.options.log(error)
      for (const run of this.data.runs) if (active(run)) Object.assign(run, { status: 'interrupted', phase: 'finished', finishedAt: new Date().toISOString(), error: 'store-write-failed' })
    }).finally(() => {
      this.runner = undefined
      if (!this.closed && !this.closing && !this.runnerFailed && this.data.runs.some(run => run.status === 'queued')) this.kick()
    })
  }
  private async drain(): Promise<void> {
    while (!this.closed && !this.closing) {
      const next = this.data.runs.find(run => run.status === 'queued')
      if (!next) return
      const id = next.id, config = structuredClone(next.config), controller = new AbortController()
      this.runningId = id; this.abort = controller
      const claimed = await this.mutate(() => { const run = this.data.runs.find(run => run.id === id)!; if (run.status !== 'queued') return false; run.status = 'running'; run.phase = 'preparing'; return true })
      if (!claimed) { this.abort = undefined; this.runningId = undefined; continue }
      const draftRoot = join(this.options.root, '.runs', id), finalReportId = randomUUID()
      this.publishingReports.add(finalReportId)
      try {
        controller.signal.throwIfAborted()
        if (config.syncSession && !config.agent.enabled) {
          try {
            const mirror = this.options.session?.()
            if (!mirror) throw new Error('scan-session-unavailable')
            const sessionId = next.sessionId ?? await mirror.start(structuredClone(next), config.kind === 'local' ? config.target : this.options.root, controller.signal)
            await this.mutate(() => { this.data.runs.find(run => run.id === id)!.sessionId = sessionId })
            await this.publishSession(id)
          } catch { await this.mutate(() => { this.data.runs.find(run => run.id === id)!.sessionWarning = true }) }
        }
        const settings = this.options.settings()
        const paths = await this.options.toolchains?.resolve(settings.semgrepPath, settings.gitleaksPath, controller.signal, { semgrep: config.engine !== 'inventory', gitleaks: config.secrets })
        const agentContext = config.agent.enabled ? this.options.agentContext?.() : undefined
        const request: AuditOptions = { target: config.kind === 'local' ? config.target : this.options.root, scope: config.scope, engine: config.engine, output: draftRoot, draft: true,
          semgrepPath: paths?.semgrepPath ?? settings.semgrepPath, gitleaksPath: paths?.gitleaksPath ?? settings.gitleaksPath, dependencies: config.dependencies, secrets: config.secrets, view: config.view, signal: controller.signal,
          ...(config.kind === 'remote' ? { url: config.target } : {}), ...(config.ref ? { ref: config.ref } : {}),
          ...(config.baseline === 'git' ? { base: config.base } : {}), ...(next.baselineReportId ? { baseline: this.reportLocation(next.baselineReportId) } : config.baseline === 'previous' ? { firstScan: true } : {}),
          // The owned worktree is the same repository and scope at a different physical path.
          ...(next.repairSource ? { identity: next.repairSource.sourceIdentity } : {}),
          ...(config.dynamicUrl && config.dynamicAuthorized ? { dynamicUrl: config.dynamicUrl } : {}),
          // Repair worktrees are rewritten to the original repository identity below, so match against it too.
          suppressions: { ...await loadSuppressions(this.suppressionFile), ...(next.repairSource ? { identity: next.repairSource.sourceIdentity } : {}) },
          onProgress: async phase => { await this.mutate(() => { const run = this.data.runs.find(run => run.id === id)!; run.phase = phase }); await this.publishSession(id) } }
        let result: Awaited<ReturnType<typeof audit>> | undefined, rulesAttempted = false
        const prepare = async (): Promise<string> => {
          rulesAttempted = true
          if (next.repairSource) await validateRepairWorkspace(next.repairSource, controller.signal)
          result = await (this.options.audit ?? audit)(request)
          await this.mutate(() => { const run = this.data.runs.find(run => run.id === id)!; run.findings = result!.report.findings.length; run.diagnostics = result!.report.engines.filter(engine => ['partial', 'unavailable', 'failed'].includes(engine.status)).map(engine => (engine.name + ': ' + engine.detail).slice(0, 2000)); if (result!.report.coverage.scannedFiles < result!.report.coverage.files) run.diagnostics.push('Source coverage: ' + result!.report.coverage.scannedFiles + '/' + result!.report.coverage.files) })
          await this.publishSession(id)
          if (config.agent.enabled) await this.mutate(() => { this.data.runs.find(run => run.id === id)!.phase = 'agent' })
          return result.json
        }
        const existingAgent = next.originSessionId && config.agent.enabled ? agentContext?.native?.agents.get(SessionId(next.originSessionId)) : undefined
        if (next.originSessionId && config.agent.enabled && !existingAgent) throw new TaskError('scan-session-unavailable')
        const canRunNative = config.agent.enabled && agentContext?.native && (existingAgent || config.agent.provider || agentContext.selection)
        if (!canRunNative) await prepare()
        if (config.agent.enabled && !controller.signal.aborted) {
          let reportSaved = false
          const reviewed = await runAgentReview({ reportFile: result?.json ?? '', ...(canRunNative ? { prepare } : {}), workspace: config.kind === 'local' ? config.target : this.options.root,
            policy: config.agent, signal: controller.signal, ...agentContext, reportLink: this.options.reportLink?.(finalReportId) ?? pathToFileURL(join(settings.reportDirectory, finalReportId, 'report.html')).href, sessionId: next.sessionId ?? 'security-' + id, ...(existingAgent ? { existingAgent } : {}),
            onSession: async sessionId => {
              await this.mutate(() => { this.data.runs.find(run => run.id === id)!.sessionId = sessionId })
              // Group the real executor in the same native workspace sidebar.
              if (existingAgent) return
              const native = agentContext?.native
              try { if (native) {
                const workspace = await native.workspaceRegistry.create(config.kind === 'local' ? config.target : this.options.root)
                await workspace.attachSession(native.sessions.get(SessionId(sessionId))!.id)
                await native.sessionController.rename({ sessionId: SessionId(sessionId), title: zh.entry + ' · ' + config.name })
              } } catch { await this.mutate(() => { this.data.runs.find(run => run.id === id)!.sessionWarning = true }) }
            },
            onComplete: async reviewed => {
              const saved = await reviewReport(result!.json, reviewed.reviews, settings.reportDirectory, reviewed.findings, reviewed.audit, false, finalReportId, reviewed.evidenceArchive)
              result = { ...result!, ...saved, report: await readReport(saved.json) }; reportSaved = true
              return { ...saved, reportId: result.report.id }
            },
            onProgress: async agent => { await this.mutate(() => { this.data.runs.find(run => run.id === id)!.agent = agent }); await this.publishSession(id) },
          })
          if (reviewed.audit.reason === 'cancelled') controller.abort()
          await this.mutate(() => { this.data.runs.find(run => run.id === id)!.agent = reviewed.audit })
          if (!result && !rulesAttempted && !controller.signal.aborted) await prepare()
          if (!result) throw new Error('scan-report-missing')
          if (!reportSaved) {
            const saved = await reviewReport(result!.json, reviewed.reviews, settings.reportDirectory, reviewed.findings, reviewed.audit, false, finalReportId, reviewed.evidenceArchive)
            result = { ...result!, ...saved, report: await readReport(saved.json) }
          }
        }
        if (!result) throw new Error('scan-report-missing')
        if (!config.agent.enabled || !result.report.agent) {
          this.publishingReports.add(result.report.id)
          result = { ...result, ...await writeReport(settings.reportDirectory, result.report) }
        }
        const finalReport = result.report
        await this.mutate(() => { const run = this.data.runs.find(run => run.id === id)!; Object.assign(run, { status: controller.signal.aborted ? run.error === 'host-restarted' ? 'interrupted' : 'cancelled' : finalReport.engines.some(engine => engine.name !== 'http' && ['failed', 'unavailable'].includes(engine.status)) || (finalReport.agent && (finalReport.agent.nativeEnd ? finalReport.agent.nativeEnd !== 'completed' : finalReport.agent.status !== 'completed')) ? 'failed' : 'succeeded', phase: 'finished', finishedAt: new Date().toISOString(), reportId: finalReport.id, reportRoot: settings.reportDirectory, findings: finalReport.findings.length, coverage: exitCode(finalReport) === 2 ? 'partial' : 'complete', resultSummary: { confirmed: finalReport.findings.filter(item => item.status === 'confirmed').length, pending: finalReport.findings.filter(item => item.status === 'needs-review').length, dismissed: finalReport.findings.filter(item => item.status === 'dismissed').length, ...(finalReport.baseline?.comparable ? { added: finalReport.findings.filter(item => item.change === 'new' && item.status !== 'dismissed').length } : {}) } }) })
      } catch (error) {
        if (!controller.signal.aborted) this.options.log(error)
        await this.mutate(() => { const run = this.data.runs.find(run => run.id === id)!; Object.assign(run, { status: controller.signal.aborted ? run.error === 'host-restarted' ? 'interrupted' : 'cancelled' : 'failed', phase: 'finished', finishedAt: new Date().toISOString(), error: controller.signal.aborted ? run.error ?? 'cancelled' : 'scan-failed' }) })
      } finally {
        await rm(draftRoot, { recursive: true, force: true }).catch(error => this.options.log(error))
        await this.publishSession(id)
        this.publishingReports.clear()
        this.abort = undefined; this.runningId = undefined
        if (this.dirtyTasks.delete(next.taskId) && !this.closing) this.queue.enqueue(next.taskId)
      }
    }
  }
  private async publishSession(id: string): Promise<void> {
    const run = this.data.runs.find(run => run.id === id)
    // The repair conversation that asked for this rescan receives only its final result; failure is non-fatal.
    if (run?.repairSessionId && run.phase === 'finished') await this.options.session?.()?.publish(run.repairSessionId, structuredClone(run)).catch(() => {})
    if (!run || run.sessionWarning) return
    if (run.config.agent.enabled && run.originSessionId === run.sessionId && (run.phase === 'agent' || (run.phase === 'finished' && run.reportId))) return
    const ids = new Set<string>()
    if (run.config.agent.enabled && !['agent', 'finished'].includes(run.phase) && run.sessionId) ids.add(run.sessionId)
    if (run.config.syncSession) {
      const noticeId = run.config.agent.enabled ? run.originSessionId : run.sessionId
      if (noticeId) ids.add(noticeId)
    }

    if (!ids.size) return
    try {
      const mirror = this.options.session?.()
      if (!mirror) throw new Error('scan-session-unavailable')
      for (const sessionId of ids) await mirror.publish(sessionId, structuredClone(run))
    } catch { await this.mutate(() => { this.data.runs.find(run => run.id === id)!.sessionWarning = true }) }
  }

  async cancel(id: string, reason: 'cancelled' | 'host-restarted' = 'cancelled'): Promise<void> {
    await this.mutate(() => {
      const run = this.data.runs.find(run => run.id === id)
      if (!run) throw new TaskError('run-not-found')
      if (run.status === 'queued') Object.assign(run, { status: reason === 'host-restarted' ? 'interrupted' : 'cancelled', phase: 'finished', finishedAt: new Date().toISOString(), error: reason })
      else if (run.status === 'running') { run.status = 'cancelling'; run.error = reason }
    })
    if (id === this.runningId) this.abort?.abort()
    await this.publishSession(id)
  }
  private get suppressionFile(): string { return join(this.options.root, 'suppressions.json') }
  /** Serialize this process's writers; the file lock covers CLI and hook writers. */
  private suppressionWrite<T>(operation: () => Promise<T>): Promise<T> {
    this.assertOpen()
    const task = this.suppressionTail.then(async () => {
      this.assertOpen()
      try { return await operation() }
      catch (error) { throw error instanceof SuppressionError ? new TaskError(error.code) : error }
    })
    const owned = task.finally(() => { this.ownedOperations.delete(owned) })
    this.ownedOperations.add(owned)
    this.suppressionTail = owned.catch(() => {})
    return task
  }
  async suppress(reportId: string, findingIds: string[], reason: string): Promise<{ added: number; existing: number }> {
    z.string().uuid().parse(reportId)
    return this.suppressionWrite(async () => addSuppressions(this.suppressionFile, await readReport(this.reportLocation(reportId)), findingIds, reason))
  }
  unsuppress(id: string): Promise<void> { return this.suppressionWrite(() => removeSuppression(this.suppressionFile, id)) }
  async suppressions(): Promise<Suppression[]> {
    try { return (await readSuppressions(this.suppressionFile)).sort((a, b) => b.createdAt.localeCompare(a.createdAt)) }
    catch (error) { throw error instanceof SuppressionError ? new TaskError(error.code) : error }
  }
  private reportLocation(id: string): string {
    const run = this.data.runs.find(run => run.reportId === id || run.rulesReportId === id)
    const comparison = this.data.runs.find(run => run.previousReportId === id)
    return reportFile(run?.reportRoot ?? comparison?.previousReportRoot ?? this.options.settings().reportDirectory, id)
  }
  async report(id: string, format: 'html' | 'json'): Promise<string> {
    const report = await readReport(this.reportLocation(id))
    const content = format === 'html' ? renderReport(report) : JSON.stringify(report, null, 2)
    if (Buffer.byteLength(content) > 24 * 1024 * 1024) throw new TaskError('report-too-large')
    return content
  }
  async source(id: string, file: string, line: number, signal: AbortSignal): Promise<{ content: string }> {
    const stored = this.reportLocation(id), report = await readReport(stored)
    if (!report.findings.some(item => (item.engine !== 'http' && item.file === file && item.line === line) || item.citations?.some(citation => citation.file === file && citation.start === line)) && !(line === 1 && report.agent?.files.includes(file)) && !report.baseline?.notObserved.some(item => item.file === file && item.line === line)) throw new TaskError('invalid-source-location')
    const workspace = isAbsolute(report.source.label) ? report.source.label : this.options.root
    try {
      const result = await readEvidence(stored, [{ file, start: Math.max(1, line - 12), count: 40 }], workspace, signal)
      return { content: result.evidence[0]!.content }
    } catch { throw new TaskError('source-unavailable') }
  }
  async settings(input: ScanSettings): Promise<void> {
    this.assertOpen()
    const value = SettingsSchema.parse(input)
    if (!isAbsolute(value.reportDirectory)) throw new TaskError('absolute-path-required')
    if (!this.options.writable()) throw new TaskError('settings-read-only')
    await this.mutate(() => this.options.updateSettings(value))
  }
  async hook(input: HookRequest): Promise<void> {
    this.assertOpen()
    const request = HookRequestSchema.parse(input)
    await this.tail
    const config = structuredClone(this.task(request.taskId, request.revision).config)
    if (config.kind !== 'local') throw new TaskError('local-hook-only')
    if (this.data.runs.some(run => run.taskId === request.taskId && active(run))) throw new TaskError('task-busy')
    const settings = this.options.settings(), abort = new AbortController()
    this.hookControllers.add(abort)
    const operation = (async () => {
      const paths = request.action === 'install' ? await this.options.toolchains?.resolve(settings.semgrepPath, settings.gitleaksPath, abort.signal, { semgrep: true, gitleaks: false }) : undefined
      return (this.options.hook ?? manageHook)({ target: config.target, event: request.event, action: request.action, enforce: request.enforce,
      output: settings.reportDirectory, semgrepPath: paths?.semgrepPath ?? settings.semgrepPath, cli: fileURLToPath(new URL('./cli.js', import.meta.url)), signal: abort.signal,
      ...(request.event === 'pre-push' && (request.base || config.base) ? { base: request.base || config.base } : {}) }) })()
    const owned = operation.finally(() => { this.ownedOperations.delete(owned); this.hookControllers.delete(abort) })
    this.ownedOperations.add(owned)
    try { await owned } catch { throw new TaskError('hook-failed') }
  }
  edited(workspace: string): boolean {
    if (this.closed || this.closing) return false
    let matched = false
    for (const task of this.data.tasks) if (task.config.autoScan && task.config.kind === 'local' && (inside(resolve(workspace), task.config.target) || inside(task.config.target, resolve(workspace)))) {
      matched = true
      if (this.data.runs.some(run => run.taskId === task.id && active(run))) this.dirtyTasks.add(task.id)
      else this.queue.enqueue(task.id)
    }
    return matched
  }
  async close(): Promise<void> {
    if (this.closing || this.closed) return
    this.closing = true
    for (const abort of this.hookControllers) abort.abort()
    await this.queue.stop()
    for (const run of [...this.data.runs]) if (active(run)) await this.cancel(run.id, 'host-restarted')
    await this.runner
    await Promise.allSettled([...this.ownedOperations])
    await this.tail
    this.closed = true
    const owned = await this.lock.stat()
    await this.lock.close()
    const path = join(this.options.root, '.tasks.lock')
    try {
      const current = await lstat(path)
      if (current.isSymbolicLink() || current.ino !== owned.ino || await readFile(path, 'utf8') !== String(process.pid) + '\n') throw new TaskError('task-store-lock-changed')
      await rm(path)
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
  }
}
