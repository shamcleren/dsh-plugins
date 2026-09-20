import { readEvidence } from './evidence.js'
import { zh } from './client/locales.js'
import { SessionId } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-workspace'
import type {} from '@deepseek-ai/dsh-api-session-controller'
import type { ScanSession } from './session.js'
import type { Toolchains } from './toolchains.js'
import { randomUUID } from 'node:crypto'
import { lstat, mkdir, open, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises'
import type { FileHandle } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { z } from 'zod'
import { runAgentReview, type AgentReviewOptions } from './agent.js'
import { audit, type AuditOptions } from './workflow.js'
import { stageReportDeletion, exitCode, listReports, readReport, renderReport, reportFile, reviewReport, writeReport } from './report.js'
import { manageHook, AuditQueue } from './hooks.js'
import { validateRepositoryUrl, inside } from './repository.js'
import { HookRequestSchema, RunSchema, SettingsSchema, TaskConfigSchema, TaskSchema, type Task, type TaskConfig, type Run, type ScanSettings, type UiState, type HookRequest, type ModelCatalog } from './ui-contract.js'

export class TaskError extends Error { constructor(readonly code: string) { super(code) } }
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
  private readonly publishingReports = new Set<string>()
  private closed = false
  private closing = false
  private runnerFailed = false
  private readonly dirtyTasks = new Set<string>()
  private readonly hookControllers = new Set<AbortController>()
  private readonly ownedOperations = new Set<Promise<unknown>>()
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
    let lock: FileHandle
    try { lock = await open(join(options.root, '.tasks.lock'), 'wx', 0o600) } catch { throw new TaskError('task-store-locked') }
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
      const index = this.data.runs.findIndex(run => !active(run))
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
  async save(input: TaskConfig, id?: string, revision?: number): Promise<Task> {
    this.assertOpen()
    const config = TaskConfigSchema.parse(input)
    if (config.kind === 'remote') config.target = validateRepositoryUrl(config.target)
    else {
      if (!isAbsolute(config.target)) throw new TaskError('absolute-path-required')
      const target = await realpath(config.target)
      if (!(await lstat(target)).isDirectory() || target === '/' || target === homedir()) throw new TaskError('code-directory-required')
      config.target = target
    }
    return this.mutate(() => {
      const previous = id ? this.task(id, revision ?? 0) : undefined
      if (!previous && this.data.tasks.length >= 100) throw new TaskError('task-limit')
      const task: Task = { id: previous?.id ?? randomUUID(), revision: (previous?.revision ?? 0) + 1, updatedAt: new Date().toISOString(), config }
      this.data.tasks = [...this.data.tasks.filter(value => value.id !== task.id), task]; return task
    })
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
      if (active(run) || this.runningId === id) throw new TaskError('run-busy')
      this.data.runs = this.data.runs.filter(run => run.id !== id)
    })
  }
  async removeReport(id: string): Promise<void> {
    this.assertOpen()
    z.string().uuid().parse(id)
    // Serialize baseline checks, filesystem staging and store updates against task starts/settings.
    const operation = this.tail.then(async () => {
      this.assertOpen()
      if (this.publishingReports.has(id) || this.data.tasks.some(task => task.config.baseline === 'report' && task.config.baselineId === id)
        || this.data.runs.some(run => (active(run) || run.id === this.runningId) && (run.config.baselineId === id || run.reportId === id || run.rulesReportId === id))) throw new TaskError('report-in-use')
      let staged: Awaited<ReturnType<typeof stageReportDeletion>>
      try { staged = await stageReportDeletion(this.reportLocation(id), id) }
      catch (error) { throw new TaskError((error as NodeJS.ErrnoException).code === 'ENOENT' ? 'report-not-found' : 'unsafe-report-delete') }
      const previous = structuredClone(this.data)
      try {
        for (const run of this.data.runs) {
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
    const run = await this.mutate(() => {
      const task = this.task(id, revision)
      if (this.data.runs.some(run => active(run) && (run.taskId === id || (sessionId && run.originSessionId === sessionId)))) throw new TaskError('task-busy')
      if (this.data.runs.filter(active).length >= 10) throw new TaskError('queue-full')
      const run: Run = { id: randomUUID(), taskId: id, config: structuredClone(task.config), status: 'queued', phase: 'queued', trigger, ...(sessionId ? { originSessionId: sessionId, sessionId } : {}), createdAt: new Date().toISOString() }
      this.data.runs.push(run)
      while (this.data.runs.length > 100) { const index = this.data.runs.findIndex(item => !active(item)); if (index < 0) throw new TaskError('queue-full'); this.data.runs.splice(index, 1) }
      return run
    })
    this.runnerFailed = false; this.kick(); return run
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
            const sessionId = next.sessionId ?? await mirror.start(structuredClone(next), config.kind === 'local' ? config.target : this.options.root)
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
          ...(config.baseline === 'git' ? { base: config.base } : {}), ...(config.baseline === 'report' ? { baseline: this.reportLocation(config.baselineId) } : {}),
          onProgress: async phase => { await this.mutate(() => { const run = this.data.runs.find(run => run.id === id)!; run.phase = phase }); await this.publishSession(id) } }
        let result: Awaited<ReturnType<typeof audit>> | undefined, rulesAttempted = false
        const prepare = async (): Promise<string> => {
          rulesAttempted = true
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
        await this.mutate(() => { const run = this.data.runs.find(run => run.id === id)!; Object.assign(run, { status: controller.signal.aborted ? run.error === 'host-restarted' ? 'interrupted' : 'cancelled' : finalReport.engines.some(engine => ['failed', 'unavailable'].includes(engine.status)) || (finalReport.agent && (finalReport.agent.nativeEnd ? finalReport.agent.nativeEnd !== 'completed' : finalReport.agent.status !== 'completed')) ? 'failed' : 'succeeded', phase: 'finished', finishedAt: new Date().toISOString(), reportId: finalReport.id, reportRoot: settings.reportDirectory, findings: finalReport.findings.length, coverage: exitCode(finalReport) === 2 ? 'partial' : 'complete', resultSummary: { confirmed: finalReport.findings.filter(item => item.status === 'confirmed').length, pending: finalReport.findings.filter(item => item.status === 'needs-review').length, dismissed: finalReport.findings.filter(item => item.status === 'dismissed').length } }) })
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
  private reportLocation(id: string): string {
    const run = this.data.runs.find(run => run.reportId === id || run.rulesReportId === id)
    return reportFile(run?.reportRoot ?? this.options.settings().reportDirectory, id)
  }
  async report(id: string, format: 'html' | 'json'): Promise<string> {
    const report = await readReport(this.reportLocation(id))
    const content = format === 'html' ? renderReport(report) : JSON.stringify(report, null, 2)
    if (Buffer.byteLength(content) > 24 * 1024 * 1024) throw new TaskError('report-too-large')
    return content
  }
  async source(id: string, file: string, line: number, signal: AbortSignal): Promise<{ content: string }> {
    const stored = this.reportLocation(id), report = await readReport(stored)
    if (!report.findings.some(item => (item.file === file && item.line === line) || item.citations?.some(citation => citation.file === file && citation.start === line)) && !(line === 1 && report.agent?.files.includes(file)) && !report.baseline?.notObserved.some(item => item.file === file && item.line === line)) throw new TaskError('invalid-source-location')
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
