import { Context, Service } from '@deepseek-ai/cordis'
import SkillRegistry from '@deepseek-ai/dsh-skill'
import ToolRuntime, { defineTool } from '@deepseek-ai/dsh-tools'
import WebServer from '@deepseek-ai/dsh-host-webserver'
import { expect, it, vi } from 'vitest'
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import * as SecurityScan from '../src/index.js'
import { SecurityTasks, TaskError } from '../src/tasks.js'
import { newTask } from '../src/ui-contract.js'

class MemorySettings extends Service {
  readonly writable = false
  constructor(ctx: Context) { super(ctx, 'settings') }
}

it.each(['before', 'after'])('coexists with foreign generic security tools and skills loaded %s', async order => {
  const ctx = new Context(), home = await mkdtemp(join(tmpdir(), 'security-coexist-')), previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = home
  ctx.provide('systemPrompt', { tools: () => undefined } as never)
  ctx.provide('webServer', { host: '127.0.0.1', register: vi.fn(() => () => {}) } as never)
  ctx.provide('connection', { admit: () => ({ peer: {} }) } as never)
  try {
    const settings = await ctx.plugin(MemorySettings), skills = await settings.ctx.plugin(SkillRegistry), tools = await skills.ctx.plugin(ToolRuntime)
    const other = { name: 'other-security-fixture', apply(scope: Context) {
      for (const name of ['security_audit', 'security_scan', 'read_evidence', 'submit_review']) scope.tools.register(defineTool({ name, description: 'Foreign fixture', parameters: {},
        output: { schema: { type: 'object', additionalProperties: false, properties: { result: { type: 'string', required: true } } }, render: (_args, value) => [{ type: 'text', text: value.result }] }, execute: async () => ({ result: 'foreign' }) }))
      scope.skills.register({ name: 'security-review', description: 'Foreign security review', source: 'runtime', content: 'Owned by another plugin.' })
    } }
    const foreign = order === 'before' ? await tools.ctx.plugin(other) : undefined
    const scan = await tools.ctx.plugin(SecurityScan, { semgrepPath: '/nonexistent/semgrep', gitleaksPath: '/nonexistent/gitleaks', reportDirectory: join(home, 'reports') })
    const later = order === 'after' ? await tools.ctx.plugin(other) : undefined
    expect(tools.ctx.tools.get('security_audit')?.description).toBe('Foreign fixture')
    expect(tools.ctx.tools.get('dsh_security_scan_audit')?.description).toContain('rules-only')
    expect(await skills.ctx.skills.get('security-review')).toMatchObject({ content: 'Owned by another plugin.' })
    expect(await skills.ctx.skills.get('dsh-security-review')).toMatchObject({ provider: 'security-scan', source: 'bundled' })
    await scan.dispose()
    expect(tools.ctx.tools.get('dsh_security_scan_audit')).toBeUndefined()
    expect(tools.ctx.tools.get('security_audit')?.description).toBe('Foreign fixture')
    expect(await skills.ctx.skills.get('security-review')).toBeDefined()
    await (foreign ?? later)!.dispose()
  } finally { await ctx.fiber.dispose(); if (previousHome === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = previousHome; await rm(home, { recursive: true, force: true }) }
})

it('registers and retracts its real DSH tool, skill and settings with the plugin lifetime', async () => {
  const ctx = new Context()
  const workspace = await mkdtemp(join(tmpdir(), 'security-tool-'))
  ctx.provide('systemPrompt', { tools: () => undefined } as never)
  ctx.provide('webServer', { host: '127.0.0.1', register: vi.fn(() => () => {}) } as never)
  ctx.provide('connection', { admit: () => ({ peer: {} }) } as never)
  try {
    const settings = await ctx.plugin(MemorySettings)
    const skills = await settings.ctx.plugin(SkillRegistry)
    const tools = await skills.ctx.plugin(ToolRuntime)
    const fiber = await tools.ctx.plugin(SecurityScan, { semgrepPath: '/nonexistent/semgrep', gitleaksPath: '/nonexistent/gitleaks', reportDirectory: join(workspace, '.dsh-security/reports') })
    expect(fiber.ctx.tools.get('dsh_security_scan_rules')?.description).toContain('Read-only')
    await writeFile(join(workspace, 'app.py'), 'print("hello")\n')
    const definition = fiber.ctx.tools.get('dsh_security_scan_rules')!
    const output = await definition.execute({ mode: 'inventory' }, {
      signal: new AbortController().signal, agent: { session: { header: { cwd: workspace } } },
    } as never) as { result: string }
    expect(JSON.parse(output.result)).toMatchObject({ status: 'inventory-only', coverage: { files: 1 } })
    await expect(fiber.ctx.skills.get('dsh-security-review')).resolves.toMatchObject({ name: 'dsh-security-review', provider: 'security-scan', source: 'bundled' })
    const context = { signal: new AbortController().signal, agent: { session: { header: { cwd: workspace } } } } as never
    const auditOutput = await fiber.ctx.tools.get('dsh_security_scan_audit')!.execute({ engine: 'inventory' }, context) as { result: string }
    const auditReport = JSON.parse(auditOutput.result)
    expect(auditReport.html).toMatch(/report.html$/u)
    const evidenceOutput = await fiber.ctx.tools.get('dsh_security_scan_read_evidence')!.execute({ report_id: auditReport.reportId, files_json: JSON.stringify([{ file: 'app.py', count: 1 }]) }, context) as { result: string }
    expect(JSON.parse(evidenceOutput.result).evidence[0].content).toContain('hello')
    const reviews = await fiber.ctx.tools.get('dsh_security_scan_review_report')!.execute({ report_id: auditReport.reportId, reviews_json: '[]', findings_json: JSON.stringify([{ file: 'app.py', line: 1, title: 'Synthetic review', cwe: '', severity: 'info', status: 'needs-review', evidence: 'Fixture only', recommendation: 'Inspect context', verification: 'Not reproduced' }]) }, context) as { result: string }
    expect(JSON.parse(reviews.result).html).not.toBe(auditReport.html)
    const listed = await fiber.ctx.tools.get('dsh_security_scan_reports')!.execute({}, context) as { result: string }
    expect(JSON.parse(listed.result)).toHaveLength(2)
    await fiber.dispose()
    for (const name of ['dsh_security_scan_start', 'dsh_security_scan_findings', 'dsh_security_scan_exclude_findings', 'dsh_security_scan_repair_rescan', 'dsh_security_scan_status', 'dsh_security_scan_rules', 'dsh_security_scan_audit', 'dsh_security_scan_read_evidence', 'dsh_security_scan_review_report', 'dsh_security_scan_reports']) expect(tools.ctx.tools.get(name)).toBeUndefined()
    expect(await skills.ctx.skills.list()).toEqual([])
  } finally { await ctx.fiber.dispose(); await rm(workspace, { recursive: true, force: true }) }
})

it('asks the user through the DSH approval pipeline before a conversation excludes findings', async () => {
  const ctx = new Context(), home = await mkdtemp(join(tmpdir(), 'security-exclude-')), previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = home
  ctx.provide('systemPrompt', { tools: () => undefined } as never)
  ctx.provide('webServer', { host: '127.0.0.1', register: vi.fn(() => () => {}) } as never)
  ctx.provide('connection', { admit: () => ({ peer: {} }) } as never)
  const targets = vi.spyOn(SecurityTasks.prototype, 'exclusionTargets')
  try {
    const settings = await ctx.plugin(MemorySettings), skills = await settings.ctx.plugin(SkillRegistry), tools = await skills.ctx.plugin(ToolRuntime)
    const fiber = await tools.ctx.plugin(SecurityScan, { semgrepPath: '/nonexistent/semgrep', gitleaksPath: '/nonexistent/gitleaks', reportDirectory: join(home, 'reports') })
    expect(fiber.ctx.tools.get('dsh_security_scan_exclude_findings')?.description).toContain('approval prompt')
    const agent = { session: { id: 'repair-session', header: { cwd: home } } }
    const decide = (args: unknown) => fiber.ctx.waterfall('tools/pre-execute', { name: 'dsh_security_scan_exclude_findings', arguments: args, agent } as never, () => Promise.resolve({ kind: 'allow' } as const))
    await vi.waitFor(() => expect(fiber.ctx.tools.get('dsh_security_scan_findings')).toBeDefined())
    expect(await decide({ finding_ids: ['f1'] })).toMatchObject({ kind: 'deny' })
    expect(targets).not.toHaveBeenCalled()
    targets.mockRejectedValueOnce(new TaskError('report-not-found'))
    expect(await decide({ finding_ids: ['f1'], reason: 'constant' })).toMatchObject({ kind: 'deny', reason: expect.stringContaining('report-not-found') })
    targets.mockResolvedValueOnce([{ reportId: crypto.randomUUID(), finding: { title: 'eval on config', file: 'app.py', line: 3 } as never }])
    const decision = await decide({ finding_ids: ['f1'], reason: '参数来自内部常量' })
    expect(decision).toMatchObject({ kind: 'ask', displayReason: { zh: expect.stringContaining('eval on config（app.py:3）') } })
    expect((decision as unknown as { displayReason: { zh: string } }).displayReason.zh).toContain('参数来自内部常量')
    expect(targets).toHaveBeenLastCalledWith('repair-session', home, ['f1'], undefined)
    // Other tools keep their own decisions.
    expect(await fiber.ctx.waterfall('tools/pre-execute', { name: 'dsh_security_scan_status', arguments: {}, agent } as never, () => Promise.resolve({ kind: 'allow' } as const))).toEqual({ kind: 'allow' })
  } finally { targets.mockRestore(); await ctx.fiber.dispose(); if (previousHome === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = previousHome; await rm(home, { recursive: true, force: true }) }
})

it('the installed release composes through the official DSH profile loader', { skip: !process.env.SECURITY_TEST_INSTALLATION }, () => {
  const result = spawnSync(join(process.env.SECURITY_TEST_INSTALLATION!, 'bin/dsh'), ['--profile', 'web', '--dump-config'], { encoding: 'utf8', timeout: 15000 })
  expect(result.status).toBe(0)
  expect(result.stderr).not.toContain('patch:')
  expect(result.stdout).toContain("name: '@shamcleren/dsh-security-scan'")
})

it('accesses optional model services only through declared injection scopes in the UI RPC', async () => {
  const ctx = new Context(), workspace = await mkdtemp(join(tmpdir(), 'security-model-scope-'))
  const previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = workspace
  ctx.provide('systemPrompt', { tools: () => undefined } as never)
  ctx.provide('connection', { admit: () => ({ peer: {} }) } as never)
  ctx.provide('llm', { listProviders: () => [{ id: 'scope-fixture', name: 'Test provider' }], listModels: async () => [{ provider: 'scope-fixture', id: 'model-fixture', name: 'Test model' }] } as never)
  ctx.provide('agentDefaultModel', { currentSelection: () => ({ provider: 'scope-fixture', model: 'model-fixture' }) } as never)
  try {
    const web = await ctx.plugin(WebServer, { host: '127.0.0.1', port: 0 })
    const call = async (endpoint: string, payload: unknown): Promise<unknown> => {
      const rpcId = crypto.randomUUID()
      const response = await fetch(`http://127.0.0.1:${web.ctx.webServer.port}/security-scan/${endpoint}`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ type: 'client-request', rpcId, method: endpoint, payload }),
      })
      expect(response.status).toBe(200)
      return (await response.json() as { result: unknown }).result
    }
    const settings = await web.ctx.plugin(MemorySettings)
    const skills = await settings.ctx.plugin(SkillRegistry)
    const tools = await skills.ctx.plugin(ToolRuntime)
    await tools.ctx.plugin(SecurityScan, { semgrepPath: '/nonexistent/semgrep', gitleaksPath: '/nonexistent/gitleaks', reportDirectory: join(workspace, 'reports') })
    expect(await call('state', {})).toMatchObject({ ok: true, value: { tasks: [], agentDefault: { provider: 'scope-fixture', model: 'model-fixture' } } })
    expect(await call('models', {})).toEqual({ ok: true, value: { models: [{ provider: 'scope-fixture', providerName: 'Test provider', model: 'model-fixture', name: 'Test model' }], partial: false } })
    await writeFile(join(workspace, 'app.py'), 'print("sample")\n')
    const exec = { signal: new AbortController().signal, agent: { session: { id: 'conversation-fixture', header: { cwd: workspace } } } } as never
    const response = await tools.ctx.tools.get('dsh_security_scan_start')!.execute({ name: 'Conversation scan', sync_session: false, agent_review: false, dependencies: false, secrets: false }, exec) as { result: string }
    const started = JSON.parse(response.result)
    expect(started).toMatchObject({ runId: expect.any(String), taskId: expect.any(String), sessionId: 'conversation-fixture' })
    const status = await tools.ctx.tools.get('dsh_security_scan_status')!.execute({ run_id: started.runId }, exec) as { result: string }
    expect(JSON.parse(status.result)).toMatchObject({ id: started.runId, trigger: 'conversation', config: { name: 'Conversation scan', syncSession: false, dependencies: false, secrets: false, agent: { enabled: false } } })
    expect(await call('state', {})).toMatchObject({ ok: true, value: { tasks: [expect.objectContaining({ id: started.taskId })], runs: [expect.objectContaining({ id: started.runId })] } })

    // Inspect the saved entry-point contract without making network/model calls.
    const start = vi.spyOn(SecurityTasks.prototype, 'start').mockResolvedValue({
      id: started.runId, taskId: started.taskId, config: newTask(), status: 'queued', phase: 'queued', trigger: 'conversation', createdAt: new Date().toISOString(),
    })
    try {
      await tools.ctx.tools.get('dsh_security_scan_start')!.execute({ name: 'Default scan' }, exec)
      const current = await call('state', {}) as { value: { tasks: Array<{ id: string; origin?: string; config: ReturnType<typeof newTask> }> } }
      // The same target reuses the conversation task, so both scans share history and the previous-report baseline.
      expect(current.value.tasks).toHaveLength(1)
      const reused = current.value.tasks[0]!, defaults = reused.config
      expect(reused).toMatchObject({ id: started.taskId, origin: 'conversation' })
      expect(defaults).toMatchObject({ name: 'Default scan', dependencies: true, secrets: true, agent: { enabled: true }, syncSession: true, baseline: 'previous' })
      expect(newTask()).toMatchObject({ dependencies: defaults.dependencies, secrets: defaults.secrets, agent: defaults.agent, baseline: defaults.baseline })
      expect(start).toHaveBeenCalledWith(started.taskId, 2, 'conversation', 'conversation-fixture')
    } finally { start.mockRestore() }

  } finally {
    await ctx.fiber.dispose()
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
    await rm(workspace, { recursive: true, force: true })
  }
})
