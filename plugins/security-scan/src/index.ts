import './message-source.js'
import { listAuditModels } from './models.js'
import type { ModelCatalog } from './ui-contract.js'
import type {} from '@deepseek-ai/dsh-host-webserver'
import { SECURITY_PRESET } from './preset-install.js'
import type {} from '@deepseek-ai/dsh-agent-preset-registry'
import { scanSession, type ScanSession } from './session.js'
import type {} from '@deepseek-ai/dsh-api-session-controller'
import type {} from '@deepseek-ai/dsh-session'
import { Toolchains, managedPath } from './toolchains.js'
import { fileURLToPath } from 'node:url'
import { resolve, dirname } from 'node:path'
import { realpath } from 'node:fs/promises'
import type {} from '@deepseek-ai/dsh-client-connection'
import type {} from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-system-prompt'
import type {} from '@deepseek-ai/dsh-workspace'
import type { AgentReviewOptions } from './agent.js'
import type {} from '@deepseek-ai/dsh-agent-default-model'
import { SecurityTasks, TaskError } from './tasks.js'
import { createSecurityRpc } from './ui-rpc.js'
import { SECURITY_CHANNEL, dynamicTarget, newTask } from './ui-contract.js'
import { readEvidence } from './evidence.js'
import { audit, loadSuppressions } from './workflow.js'
import { defaultSuppressionsFile } from './suppressions.js'
import { defaultReportsRoot, listReports, reportFile, reviewReport, ReviewSchema, AdditionalFindingSchema } from './report.js'
import { inside } from './repository.js'
import { AuditQueue, DEFAULT_EDIT_TOOLS, isConfiguredEdit } from './hooks.js'
import { z as jsonSchema } from 'zod'
import { type Volatile, type Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'
import * as SkillFilesystem from '@deepseek-ai/dsh-skill-filesystem'
import type {} from '@deepseek-ai/dsh-settings'
import { scanWorkspace } from './scanner.js'
import { registerHostRpc } from './host-rpc.js'

export const name = 'security-scan'
const EXCLUDE_TOOL = 'dsh_security_scan_exclude_findings'
export const inject = ['skills', 'tools', 'settings', 'connection', 'webServer']
export interface Config { semgrepPath?: string; gitleaksPath?: string; reportDirectory?: string; autoScan?: boolean; hookTools?: string[] }
const ConfigSchema: z<Config> = z.object({ semgrepPath: z.string().default('semgrep'), gitleaksPath: z.string().default('gitleaks'), reportDirectory: z.string(), autoScan: z.boolean().default(false), hookTools: z.array(z.string()).default(DEFAULT_EDIT_TOOLS) })

export const Config = ConfigSchema.volatile()

/** Register the read-only scanner and a review workflow on public DSH extension points. */
export function apply(ctx: Context, config: Config | Volatile<Config> = {}): void {
  // Cloning detaches the validated readonly snapshot for existing mutable config consumers.
  const scope = { get: (): Config => ('get' in config) ? structuredClone(config.get()) as Config : config }
  SkillFilesystem.apply(ctx, { providerName: name, includeDefaultRoots: false,
    bundledSkillDir: fileURLToPath(new URL('../skills', import.meta.url)), watch: false })
  const lifetime = new AbortController()
  const toolchains = new Toolchains()
  if (managedPath(scope.get().semgrepPath, 'semgrep') || managedPath(scope.get().gitleaksPath, 'gitleaks')) void toolchains.setup().catch(() => { ctx.logger.warn('Security engines could not be prepared; retry in the security workspace.') })
  ctx.effect(() => () => toolchains.close(), 'security-scan: managed engines')
  const pending = new Set<Promise<unknown>>()
  ctx.effect(() => async () => { lifetime.abort(); await Promise.allSettled([...pending]) }, 'security-scan: owned scans')
  const output = { schema: { type: 'object' as const, additionalProperties: false, properties: { result: { type: 'string' as const, required: true as const } } }, render: (_args: unknown, value: { result: string }) => [{ type: 'text' as const, text: value.result }] }
  const reportsRoot = (): string => scope.get().reportDirectory ?? defaultReportsRoot()
  const queue = new AuditQueue(async (workspace, signal) => {
    if (!scope.get().autoScan) return
    const paths = await toolchains.resolve(scope.get().semgrepPath, scope.get().gitleaksPath, signal, { semgrep: true, gitleaks: false })
    const result = await audit({ target: workspace, scope: 'diff', base: 'HEAD', semgrepPath: paths.semgrepPath, output: reportsRoot(), signal })
    ctx.logger.info('Security report: ' + result.html)
  }, () => { ctx.logger.warn('Automatic security scan incomplete; run dsh_security_scan_audit for diagnostics.') })
  let models: (() => Promise<ModelCatalog>) | undefined
  ctx.inject(['llm'], modelCtx => {
    const owned = () => {
      const operation = listAuditModels(modelCtx.llm)
      pending.add(operation)
      void operation.finally(() => pending.delete(operation)).catch(() => {})
      return operation
    }
    models = owned
    modelCtx.effect(() => () => { if (models === owned) models = undefined }, 'security-scan: model catalog')
  })
  let native: Context | undefined
  let selection: (() => NonNullable<AgentReviewOptions['selection']>) | undefined
  ctx.inject(['agents', 'sessions', 'tools', 'systemPrompt', 'workspaceRegistry', 'sessionController', 'agentPresets'], nativeCtx => {
    native = nativeCtx
    nativeCtx.effect(() => () => { if (native === nativeCtx) native = undefined }, 'security-scan: native agent')
  })
  ctx.inject(['agentDefaultModel'], modelCtx => {
    const owned = () => modelCtx.agentDefaultModel.currentSelection()
    selection = owned
    modelCtx.effect(() => () => { if (selection === owned) selection = undefined }, 'security-scan: default model')
  })
  let sessionMirror: ScanSession | undefined
  ctx.inject(['agents', 'sessions', 'workspaceRegistry', 'sessionController'], sessionCtx => {
    const owned = scanSession(sessionCtx)
    sessionMirror = owned
    sessionCtx.effect(() => () => { if (sessionMirror === owned) sessionMirror = undefined }, 'security-scan: session synchronization')
  })
  let reportOrigin: (() => string) | undefined
  ctx.inject(['webServer'], webCtx => {
    const owned = () => 'http://127.0.0.1:' + webCtx.webServer.port
    reportOrigin = owned
    webCtx.effect(() => () => { if (reportOrigin === owned) reportOrigin = undefined }, 'security-scan: report navigation')
  })
  let tasks: SecurityTasks | undefined
  const taskReady = SecurityTasks.open({ models: () => models ? models() : Promise.resolve({ models: [], partial: true }), reportLink: id => reportOrigin ? reportOrigin() + '/#dsh-security-report=' + id : undefined, toolchains, session: () => sessionMirror, root: dirname(defaultReportsRoot()),
    agentContext: () => {
      const owned = native, presets = owned?.agentPresets
      return { ...(owned && presets ? { native: owned, keepSession: true, preset: { id: SECURITY_PRESET, async mount(agentCtx: Context) { await presets.mount(agentCtx, SECURITY_PRESET) } } } : {}), ...(selection ? { selection: selection() } : {}) }
    },
    settings: () => ({ semgrepPath: scope.get().semgrepPath ?? 'semgrep', gitleaksPath: scope.get().gitleaksPath ?? 'gitleaks', reportDirectory: resolve(reportsRoot()), autoScan: scope.get().autoScan ?? false, hookTools: scope.get().hookTools ?? DEFAULT_EDIT_TOOLS }),
    writable: () => ctx.settings.writable,
    updateSettings: async value => { await ctx.settings.update(name, value) },
    log: () => { ctx.logger.warn('Security task operation failed; check task state and configured paths.') },
  })
  void taskReady.then(service => { tasks = service }).catch(() => { ctx.logger.warn('Security task store unavailable; check its ownership lock and permissions.') })
  ctx.effect(() => async () => { try { const service = await taskReady; if (tasks === service) tasks = undefined; await service.close() } catch { ctx.logger.warn('Security task shutdown did not complete; inspect its owner lock before restarting.') } }, 'security-scan: task manager')
  if (ctx.webServer.host !== '127.0.0.1') throw new Error('Plugin management requires a loopback Web server')
  registerHostRpc(ctx, SECURITY_CHANNEL, createSecurityRpc(taskReady, () => { ctx.logger.warn('Security workspace request failed.') }))
  ctx.on('tools/result', (exec, result) => {
    const workspace = exec.agent?.session.header.cwd
    if (!workspace || result.isError || !isConfiguredEdit(exec.name, exec.arguments, scope.get().hookTools ?? DEFAULT_EDIT_TOOLS)) return
    const operation = realpath(workspace).then(async path => {
      const service = taskReady ? await taskReady : undefined
      if (!service?.edited(path) && scope.get().autoScan) queue.enqueue(path)
    }).catch(() => { ctx.logger.warn('Automatic security scan could not start.') }).finally(() => { pending.delete(operation) })
    pending.add(operation)
  })
  ctx.effect(() => () => queue.stop(), 'security-scan: automatic audit queue')
  ctx.tools.register(defineTool({
    name: 'dsh_security_scan_start', description: 'Start a background security scan from this conversation. Shares the security workspace task queue and reports. Returns a run id immediately; AI review continues as a queued native turn in this existing session, preserving its model and title. Do not poll repeatedly or wait inside this turn; finish your reply so the queued audit can proceed. Dependency vulnerabilities, secret detection and Agentic AI review are enabled by default; explicit false overrides are honored. Preferred for repository scans; use dsh_security_scan_status to inspect results. Does not apply fixes.',
    parameters: {
      path: { type: 'string', description: 'Directory inside the active workspace; defaults to its root.' },
      url: { type: 'string', description: 'Repository URL explicitly requested by the user.' },
      name: { type: 'string', description: 'Short task title.' }, ref: { type: 'string' },
      scope: { type: 'string', enum: ['full', 'diff', 'staged'] }, base: { type: 'string', description: 'Required for diff.' },
      dependencies: { type: 'boolean', description: 'Defaults to true. Queries OSV with dependency names/versions, not source code. Set false only when the user requests no dependency checks or no network queries.' },
      secrets: { type: 'boolean', description: 'Defaults to true. Local Gitleaks secret detection; set false only when explicitly excluded.' }, agent_review: { type: 'boolean', description: 'Defaults to true. Native DSH Agentic AI review with the configured DSH model. Set false only for an explicitly requested rules-only scan.' },
      sync_session: { type: 'boolean', description: 'Write progress notices to this conversation; defaults to true.' },
      dynamic_url: { type: 'string', description: 'Optional http(s) URL of a running service the user explicitly owns and asked to check. Adds a read-only runtime baseline (at most 12 same-origin GET requests: security headers, cookies, CORS, debug pages, exposed files). Never infer or guess a URL.' },
    }, output,
    async execute(args, exec) {
      const workspace = exec.agent?.session.header.cwd
      if (!workspace || !taskReady) throw new Error('Select a workspace and enable the security task service')
      if (args.path && args.url) throw new Error('Choose a local path or repository URL')
      const root = await realpath(workspace), target = await realpath(resolve(root, args.path ?? '.'))
      if (!inside(root, target)) throw new Error('Scan directory must be inside the active workspace')
      exec.signal.throwIfAborted()
      const operation = (async () => {
        const service = await taskReady!, config = newTask(), scope = args.scope ?? 'full'
        // Repeated conversation scans of one target share a task and compare with its previous report.
        Object.assign(config, { name: (args.name ?? 'Security scan').slice(0, 100), target: args.url ?? target, kind: args.url ? 'remote' : 'local', ref: args.ref ?? '', scope, base: args.base ?? '', baseline: args.base ? 'git' : scope === 'staged' ? 'none' : 'previous', dependencies: args.dependencies ?? config.dependencies, secrets: args.secrets ?? config.secrets, syncSession: args.sync_session ?? true })
        config.agent.enabled = args.agent_review ?? config.agent.enabled
        // A URL passed by the conversation is the user's explicit request; authorization is recorded with it.
        if (args.dynamic_url) Object.assign(config, { dynamicUrl: dynamicTarget(args.dynamic_url).href, dynamicAuthorized: true })
        const task = await service.saveConversation(config)
        let run
        try { run = await service.start(task.id, task.revision, 'conversation', exec.agent!.session.id) }
        catch (error) {
          const busy = error instanceof TaskError && error.code === 'task-busy' ? (await service.state()).runs.find(item => item.taskId === task.id && ['queued', 'running', 'cancelling'].includes(item.status)) : undefined
          if (!busy) throw error
          return { result: JSON.stringify({ taskId: task.id, runId: busy.id, status: busy.status, alreadyRunning: true, instruction: 'A scan of this target is already queued or running. Do not start another one; tell the user, and read it later with dsh_security_scan_status.' }) }
        }
        return { result: JSON.stringify({ taskId: task.id, runId: run.id, status: run.status, sessionId: run.sessionId, comparesWith: run.baselineReportId ?? null, instruction: 'Scan queued in this same session. End this reply now; the native audit will continue here after this turn. Do not wait or poll in a loop, and do not start a duplicate scan.' }) }
      })()
      pending.add(operation)
      try { return await operation } finally { pending.delete(operation) }
    },
  }))
  // Excluding findings changes what later scans report, so each call goes through the DSH approval prompt.
  // The preview is resolved here, before the user is asked; an unresolvable request is denied without prompting.
  ctx.on('tools/pre-execute', async (exec, next) => {
    const decision = await next()
    if (decision.kind !== 'allow' || exec.name !== EXCLUDE_TOOL) return decision
    const args = exec.arguments as { finding_ids?: unknown; reason?: unknown; report_id?: unknown }
    if (!taskReady || !exec.agent) return { kind: 'deny', reason: 'Excluding findings requires a DSH conversation with the security task service.' }
    if (!Array.isArray(args.finding_ids) || typeof args.reason !== 'string' || !args.reason.trim() || (args.report_id !== undefined && typeof args.report_id !== 'string')) return { kind: 'deny', reason: 'Provide finding_ids (1-20 IDs) and a non-empty reason.' }
    try {
      const targets = await (await taskReady).exclusionTargets(exec.agent.session.id, exec.agent.session.header.cwd, args.finding_ids as string[], args.report_id as string | undefined)
      const list = targets.map(({ finding }) => '- ' + finding.title.slice(0, 160) + '（' + (finding.endpoint?.url ?? finding.file + ':' + finding.line) + '）').join('\n')
      const reason = args.reason.trim().slice(0, 500)
      return { kind: 'ask', reason: 'exclude ' + targets.length + ' security findings from later scans: ' + reason,
        displayReason: { en: 'Mark ' + targets.length + ' finding(s) as false positives and hide them in later scans of this repository.\n' + list + '\nReason: ' + reason + '\nRestore them under Security Scan → Settings → Excluded findings.',
          zh: '将 ' + targets.length + ' 项标记为误报，此后扫描该仓库时自动隐藏：\n' + list + '\n原因：' + reason + '\n可在“安全扫描 → 扫描设置 → 已排除的问题”中恢复。' } }
    } catch (error) {
      const code = error instanceof TaskError ? error.code : 'invalid-input'
      return { kind: 'deny', reason: code === 'finding-not-suppressible' ? 'AI-added findings have no stable identity across scans and cannot be excluded.' : code === 'unknown-finding' ? 'Unknown finding ID. Use IDs from dsh_security_scan_findings or the repair request.' : 'No report of this conversation or workspace matches the request (' + code + ').' }
    }
  })
  ctx.tools.register(defineTool({
    name: 'dsh_security_scan_findings', description: 'List the actionable findings (id, title, location, severity, review status) of a security report this conversation owns: its repair chain, scans it started, or a local scan inside the current workspace. Defaults to the newest such report. Read-only.',
    parameters: { report_id: { type: 'string', description: 'Report UUID; defaults to the newest report of this conversation.' } }, output,
    async execute(args, exec) {
      if (!taskReady || !exec.agent) throw new Error('Select a DSH conversation')
      exec.signal.throwIfAborted()
      const operation = (async () => {
        const result = await (await taskReady!).reportFindings(exec.agent!.session.id, exec.agent!.session.header.cwd, args.report_id)
        return { result: JSON.stringify(result) }
      })()
      pending.add(operation)
      try { return await operation } finally { pending.delete(operation) }
    },
  }))
  ctx.tools.register(defineTool({
    name: EXCLUDE_TOOL, description: 'Request that findings you verified as false positives, or that the user decided not to fix, be excluded so later scans of this repository hide them. State your evidence first, then call this once with all such IDs: DSH shows the user an approval prompt, which is the user\'s decision, so do not ask for confirmation separately. If the user rejects it, keep the findings and do not request again. Never use it to hide a real vulnerability that is not fixed. Accepts finding IDs from the repair request or dsh_security_scan_findings; AI-added findings cannot be excluded. The user can restore exclusions in the security workbench settings.',
    parameters: {
      finding_ids: { type: 'array', items: { type: 'string' }, required: true, description: '1-20 finding IDs.' },
      reason: { type: 'string', required: true, description: 'Evidence-based reason shown to the user and stored with the exclusion, at most 500 characters.' },
      report_id: { type: 'string', description: 'Report UUID; defaults to this conversation\'s repair chain or scans.' },
    }, output,
    async execute(args, exec) {
      if (!taskReady || !exec.agent) throw new Error('Select a DSH conversation')
      exec.signal.throwIfAborted()
      const operation = (async () => {
        const result = await (await taskReady!).excludeFromSession(exec.agent!.session.id, exec.agent!.session.header.cwd, args.finding_ids, args.reason.trim().slice(0, 500), args.report_id)
        return { result: JSON.stringify({ ...result, instruction: 'Excluded findings are hidden in later scans of this repository and no longer offered for repair. A rescan reports them as excluded.' }) }
      })()
      pending.add(operation)
      try { return await operation } finally { pending.delete(operation) }
    },
  }))
  ctx.tools.register(defineTool({
    name: 'dsh_security_scan_record_repair_delivery', description: 'Record the actual draft PR URL after successful creation by an authorized platform tool. Only the repair session can record its own repository URL. Does not create a PR or verify the remote PR status.',
    parameters: { url: { type: 'string', required: true } }, output,
    async execute(args, exec) {
      if (!taskReady || !exec.agent) throw new Error('Repair session required')
      exec.signal.throwIfAborted()
      const operation = (async () => { await (await taskReady!).recordRepairDelivery(exec.agent!.session.id, args.url); return { result: JSON.stringify({ recorded: true }) } })()
      pending.add(operation)
      try { return await operation } finally { pending.delete(operation) }
    },
  }))
  ctx.tools.register(defineTool({
    name: 'dsh_security_scan_repair_rescan', description: 'Queue one rescan after you have fixed and tested findings in a security repair session. Uses the original scan configuration on the same repair target, compares with the latest report in this repair chain, and posts the result back to this session. Only the repair session can call it. Returns immediately; do not wait or poll.',
    parameters: {}, output,
    async execute(_args, exec) {
      if (!taskReady || !exec.agent) throw new Error('Repair session required')
      exec.signal.throwIfAborted()
      const operation = (async () => { const run = await (await taskReady!).repairRescan(exec.agent!.session.id); return { result: JSON.stringify({ runId: run.id, status: run.status, instruction: 'Rescan queued. Finish your summary now; the comparison result will be posted to this conversation when the scan ends.' }) } })()
      pending.add(operation)
      try { return await operation } finally { pending.delete(operation) }
    },
  }))
  ctx.tools.register(defineTool({
    name: 'dsh_security_scan_status', description: 'Read a background security scan run by id, including progress, errors and report identity. Does not start another scan.',
    parameters: { run_id: { type: 'string', required: true } }, output,
    async execute(args, exec) {
      if (!taskReady || !exec.agent?.session.header.cwd) throw new Error('Select a workspace')
      jsonSchema.string().uuid().parse(args.run_id)
      const operation = (async () => {
        const state = await (await taskReady!).state(), run = state.runs.find(run => run.id === args.run_id)
        if (!run) throw new Error('Scan run not found')
        const root = await realpath(exec.agent!.session.header.cwd!)
        if (run.config.kind === 'remote' ? (run.originSessionId ?? run.sessionId) !== exec.agent!.session.id : !inside(root, await realpath(run.config.target))) throw new Error('Scan belongs to another workspace or conversation')
        return { result: JSON.stringify(run) }
      })()
      pending.add(operation)
      try { return await operation } finally { pending.delete(operation) }

    },
  }))
  ctx.tools.register(defineTool({
    name: 'dsh_security_scan_audit', description: 'Low-level synchronous rules-only tool, for an explicitly requested rules-only scan. For normal security scans always use dsh_security_scan_start, which defaults to dependency checks, secret detection and native Agentic AI review. Scan the current workspace or an explicitly requested repository URL. Produces canonical JSON and offline HTML reports. Supports full/diff/staged and baseline comparison. Static findings need evidence review. Optional dependency queries send names/versions to OSV only when dependencies=true.',
    parameters: {
      path: { type: 'string', description: 'Directory inside the active workspace.' },
      url: { type: 'string', description: 'HTTPS/SSH repository URL explicitly provided by the user; cloned into a private temporary bare repository.' },
      ref: { type: 'string' }, scope: { type: 'string', enum: ['full', 'diff', 'staged'] }, base: { type: 'string', description: 'Explicit target branch/commit; required for diff.' },
      baseline_id: { type: 'string', description: 'Previous report UUID from this plugin.' },
      dependencies: { type: 'boolean', description: 'User opt-in to send dependency names/versions to OSV.' }, secrets: { type: 'boolean' },
      engine: { type: 'string', enum: ['auto', 'inventory', 'semgrep'] }, view: { type: 'string', enum: ['all', 'new'] },
      dynamic_url: { type: 'string', description: 'Optional http(s) URL of a running service the user explicitly owns and asked to check; read-only same-origin GET baseline.' },
    }, output,
    async execute(args, exec) {
      const workspace = exec.agent?.session.header.cwd
      if (!workspace) throw new Error('Select a DSH workspace before scanning')
      const root = await realpath(workspace), target = await realpath(resolve(root, args.path ?? '.'))
      if (!inside(root, target)) throw new Error('Audit directory must be inside the active workspace')
      const signal = AbortSignal.any([exec.signal, lifetime.signal])
      const task = toolchains.resolve(scope.get().semgrepPath, scope.get().gitleaksPath, signal, { semgrep: args.engine !== 'inventory', gitleaks: args.secrets ?? false }).then(async paths => audit({ target, suppressions: await loadSuppressions(defaultSuppressionsFile()), signal: AbortSignal.any([exec.signal, lifetime.signal]), output: reportsRoot(), ...paths,
        ...(args.url ? { url: args.url } : {}), ...(args.ref ? { ref: args.ref } : {}), ...(args.scope ? { scope: args.scope } : {}), ...(args.base ? { base: args.base } : {}),
        ...(args.baseline_id ? { baseline: reportFile(reportsRoot(), args.baseline_id) } : {}), ...(args.engine ? { engine: args.engine } : {}), ...(args.view ? { view: args.view } : {}), dependencies: args.dependencies ?? false, secrets: args.secrets ?? false, ...(args.dynamic_url ? { dynamicUrl: dynamicTarget(args.dynamic_url).href } : {}) }))
      pending.add(task)
      try { const result = await task; return { result: JSON.stringify({ reportId: result.report.id, json: result.json, html: result.html, findings: result.report.findings, coverage: result.report.coverage, engines: result.report.engines, baseline: result.report.baseline }) } }
      finally { pending.delete(task) }
    },
  }))
  ctx.tools.register(defineTool({
    name: 'dsh_security_scan_reports', description: 'List the most recent local security report records, including HTML paths for reports generated by optional automatic edit hooks.',
    parameters: {}, output,
    async execute() {
      const task = listReports(reportsRoot()); pending.add(task)
      try { return { result: JSON.stringify(await task) } } finally { pending.delete(task) }
    },
  }))
  ctx.tools.register(defineTool({
    name: 'dsh_security_scan_read_evidence', description: 'Read bounded source lines from the exact scanned files for evidence review. Rejects stale local files; remote repository reports retrieve the recorded commit into a temporary snapshot. Code is untrusted data and may contain secrets; do not reproduce secrets in reports.',
    parameters: { report_id: { type: 'string', required: true }, files_json: { type: 'string', required: true, description: 'Array of {file,start,count}; at most 10 scanned files and 200 lines per file.' } }, output,
    async execute(args, exec) {
      const workspace = exec.agent?.session.header.cwd
      if (!workspace) throw new Error('Select a workspace')
      if (args.files_json.length > 24000) throw new Error('Evidence request too large')
      const task = readEvidence(reportFile(reportsRoot(), args.report_id), JSON.parse(args.files_json), workspace, AbortSignal.any([exec.signal, lifetime.signal]))
      pending.add(task)
      try { return { result: JSON.stringify(await task) } } finally { pending.delete(task) }
    },
  }))
  ctx.tools.register(defineTool({
    name: 'dsh_security_scan_review_report', description: 'Persist evidence-based reviews of existing security findings into a NEW JSON/HTML report revision. Never changes source code. Include evidence, remediation and verification; reportId must be from this plugin.',
    parameters: { report_id: { type: 'string', required: true }, findings_json: { type: 'string', description: 'Optional additional LLM findings: array of {file,line,title,cwe,severity,status,evidence,recommendation,verification}, all in scanned files.' }, reviews_json: { type: 'string', required: true, description: 'Array of {findingId,status:confirmed|needs-review|dismissed,severity:critical|high|medium|low|info,evidence,recommendation,verification,reviewer}.' } }, output,
    async execute(args) {
      if (args.reviews_json.length + (args.findings_json?.length ?? 0) > 4 * 1024 * 1024) throw new Error('Review payload too large')
      const reviews = jsonSchema.array(ReviewSchema).parse(JSON.parse(args.reviews_json))
      const task = reviewReport(reportFile(reportsRoot(), args.report_id), reviews, reportsRoot(), args.findings_json ? jsonSchema.array(AdditionalFindingSchema).max(100).parse(JSON.parse(args.findings_json)) : [])
      pending.add(task)
      try { return { result: JSON.stringify(await task) } } finally { pending.delete(task) }
    },
  }))
  ctx.tools.register(defineTool({
    name: 'dsh_security_scan_rules',
    description: 'Read-only Python, Go, JavaScript and TypeScript security scan of the current DSH workspace. Automatically prepares the plugin-managed Semgrep; reports missing coverage explicitly. Findings are candidates requiring dsh-security-review Skill confirmation. Does not install project dependencies, execute project code, upload code, or apply fixes.',
    parameters: {
      path: { type: 'string', description: 'Directory within the current workspace; defaults to the workspace root.' },
      mode: { type: 'string', enum: ['auto', 'inventory', 'semgrep'], description: 'auto tries the verified scanner; inventory only lists coverage.' },
    },
    output: {
      schema: { type: 'object', additionalProperties: false, properties: { result: { type: 'string', required: true } } },
      render: (_args, value) => [{ type: 'text', text: value.result }],
    },
    async execute(args, exec) {
      const workspace = exec.agent?.session.header.cwd
      if (!workspace) throw new Error('Select a DSH workspace before scanning')
      const signal = AbortSignal.any([exec.signal, lifetime.signal])
      const task = toolchains.resolve(scope.get().semgrepPath, scope.get().gitleaksPath, signal, { semgrep: args.mode !== 'inventory', gitleaks: false }).then(paths => scanWorkspace({ workspace, signal: AbortSignal.any([exec.signal, lifetime.signal]),
        ...(args.path === undefined ? {} : { path: args.path }), ...(args.mode === undefined ? {} : { mode: args.mode }),
        semgrepPath: paths.semgrepPath }))
      pending.add(task)
      try { return { result: JSON.stringify(await task) } }
      finally { pending.delete(task) }
    },
  }))
}
