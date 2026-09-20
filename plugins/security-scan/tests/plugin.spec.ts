import { Context } from '@deepseek-ai/cordis'
import SkillRegistry from '@deepseek-ai/dsh-skill'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import WebServer from '@deepseek-ai/dsh-host-webserver'
import { SettingsProvider } from '@deepseek-ai/dsh-settings'
import { expect, it, vi } from 'vitest'
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import * as SecurityScan from '../src/index.js'
import { SecurityTasks } from '../src/tasks.js'
import { newTask } from '../src/ui-contract.js'

class MemorySettings extends SettingsProvider {
  readonly writable = true
  protected async load(): Promise<Record<string, unknown>> { return {} }
  protected async persist(): Promise<void> {}
}

it('registers and retracts its real DSH tool, skill and settings with the plugin lifetime', async () => {
  const ctx = new Context()
  const workspace = await mkdtemp(join(tmpdir(), 'security-tool-'))
  ctx.provide('systemPrompt', { tools: () => undefined } as never)
  ctx.provide('webServer', { host: '127.0.0.1', register: vi.fn(() => () => {}) } as never)
  ctx.provide('connection', { requestRejection: vi.fn() } as never)
  try {
    const settings = await ctx.plugin(MemorySettings)
    const skills = await settings.ctx.plugin(SkillRegistry)
    const tools = await skills.ctx.plugin(ToolRuntime)
    const fiber = await tools.ctx.plugin(SecurityScan, { semgrepPath: '/nonexistent/semgrep', gitleaksPath: '/nonexistent/gitleaks', reportDirectory: join(workspace, '.dsh-security/reports') })
    expect(fiber.ctx.tools.get('security_scan')?.description).toContain('Read-only')
    await writeFile(join(workspace, 'app.py'), 'print("hello")\n')
    const definition = fiber.ctx.tools.get('security_scan')!
    const output = await definition.execute({ mode: 'inventory' }, {
      signal: new AbortController().signal, agent: { session: { header: { cwd: workspace } } },
    } as never) as { result: string }
    expect(JSON.parse(output.result)).toMatchObject({ status: 'inventory-only', coverage: { files: 1 } })
    await expect(fiber.ctx.skills.get('security-review')).resolves.toMatchObject({ name: 'security-review', provider: 'security-scan', source: 'bundled' })
    const context = { signal: new AbortController().signal, agent: { session: { header: { cwd: workspace } } } } as never
    const auditOutput = await fiber.ctx.tools.get('security_audit')!.execute({ engine: 'inventory' }, context) as { result: string }
    const auditReport = JSON.parse(auditOutput.result)
    expect(auditReport.html).toMatch(/report.html$/u)
    const evidenceOutput = await fiber.ctx.tools.get('security_read_evidence')!.execute({ report_id: auditReport.reportId, files_json: JSON.stringify([{ file: 'app.py', count: 1 }]) }, context) as { result: string }
    expect(JSON.parse(evidenceOutput.result).evidence[0].content).toContain('hello')
    const reviews = await fiber.ctx.tools.get('security_review_report')!.execute({ report_id: auditReport.reportId, reviews_json: '[]', findings_json: JSON.stringify([{ file: 'app.py', line: 1, title: 'Synthetic review', cwe: '', severity: 'info', status: 'needs-review', evidence: 'Fixture only', recommendation: 'Inspect context', verification: 'Not reproduced' }]) }, context) as { result: string }
    expect(JSON.parse(reviews.result).html).not.toBe(auditReport.html)
    const listed = await fiber.ctx.tools.get('security_reports')!.execute({}, context) as { result: string }
    expect(JSON.parse(listed.result)).toHaveLength(2)
    await fiber.dispose()
    for (const name of ['security_start_scan', 'security_scan_status', 'security_scan', 'security_audit', 'security_read_evidence', 'security_review_report', 'security_reports']) expect(tools.ctx.tools.get(name)).toBeUndefined()
    expect(await skills.ctx.skills.list()).toEqual([])
  } finally { await ctx.fiber.dispose(); await rm(workspace, { recursive: true, force: true }) }
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
  ctx.provide('connection', { requestRejection: () => undefined } as never)
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
    const response = await tools.ctx.tools.get('security_start_scan')!.execute({ name: 'Conversation scan', sync_session: false, agent_review: false, dependencies: false, secrets: false }, exec) as { result: string }
    const started = JSON.parse(response.result)
    expect(started).toMatchObject({ runId: expect.any(String), taskId: expect.any(String), sessionId: 'conversation-fixture' })
    const status = await tools.ctx.tools.get('security_scan_status')!.execute({ run_id: started.runId }, exec) as { result: string }
    expect(JSON.parse(status.result)).toMatchObject({ id: started.runId, trigger: 'conversation', config: { name: 'Conversation scan', syncSession: false, dependencies: false, secrets: false, agent: { enabled: false } } })
    expect(await call('state', {})).toMatchObject({ ok: true, value: { tasks: [expect.objectContaining({ id: started.taskId })], runs: [expect.objectContaining({ id: started.runId })] } })

    // Inspect the saved entry-point contract without making network/model calls.
    const start = vi.spyOn(SecurityTasks.prototype, 'start').mockResolvedValue({
      id: started.runId, taskId: started.taskId, config: newTask(), status: 'queued', phase: 'queued', trigger: 'conversation', createdAt: new Date().toISOString(),
    })
    try {
      await tools.ctx.tools.get('security_start_scan')!.execute({ name: 'Default scan' }, exec)
      const current = await call('state', {}) as { value: { tasks: Array<{ config: ReturnType<typeof newTask> }> } }
      const defaults = current.value.tasks.find(task => task.config.name === 'Default scan')!.config
      expect(defaults).toMatchObject({ dependencies: true, secrets: true, agent: { enabled: true }, syncSession: true })
      expect(newTask()).toMatchObject({ dependencies: defaults.dependencies, secrets: defaults.secrets, agent: defaults.agent })
      expect(start).toHaveBeenCalledWith(expect.any(String), 1, 'conversation', 'conversation-fixture')
    } finally { start.mockRestore() }

  } finally {
    await ctx.fiber.dispose()
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
    await rm(workspace, { recursive: true, force: true })
  }
})
