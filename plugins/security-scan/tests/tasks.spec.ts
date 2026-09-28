import { spawnSync } from 'node:child_process'
import { mkdtemp, mkdir, realpath, readFile, rm, writeFile, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { afterEach, expect, it, vi } from 'vitest'
import { SecurityTasks } from '../src/tasks.js'
import { audit } from '../src/workflow.js'
import { createSecurityRpc } from '../src/ui-rpc.js'
import { newTask, type ScanSettings } from '../src/ui-contract.js'
import { AgentAuditSchema } from '../src/agent-contract.js'
const roots: string[] = [], services: SecurityTasks[] = []
afterEach(async () => { await Promise.all(services.splice(0).map(service => service.close())); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })
async function fixture(overrides: Partial<Parameters<typeof SecurityTasks.open>[0]> = {}) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'security-ui-test-'))); roots.push(root)
  const target = join(root, 'repo'); await mkdir(target); await writeFile(join(target, 'app.py'), 'print("test")\n')
  let settings: ScanSettings = { semgrepPath: '/missing/semgrep', gitleaksPath: '/missing/gitleaks', reportDirectory: join(root, 'reports'), autoScan: false, hookTools: ['write_file'] }
  const options = { root: join(root, 'store'), settings: () => ({ ...settings }), writable: () => true, updateSettings: async (value: ScanSettings) => { settings = value }, log: vi.fn(), ...overrides }
  const service = await SecurityTasks.open(options); services.push(service)
  const config = { ...newTask(), name: 'Example task', target, engine: 'inventory' as const, dependencies: false, secrets: false, agent: { ...newTask().agent, enabled: false } }
  return { root, target, service, config, options }
}

it('prunes large completed AI histories before they can exceed the restart read limit', async () => {
  const f = await fixture(); await f.service.close()
  const agent = AgentAuditSchema.parse({ status: 'completed', reason: 'completed', provider: 'fixture', model: 'fixture', steps: 1, areas: ['injection'], files: Array.from({ length: 100 }, (_, index) => String(index).padEnd(2000, 'f')), reviewedFindings: 0, inputTokens: 0, outputTokens: 0, usageAvailable: false, events: [] })
  const runs = Array.from({ length: 21 }, () => ({ id: randomUUID(), taskId: randomUUID(), config: f.config, status: 'succeeded', phase: 'finished', trigger: 'manual', createdAt: new Date().toISOString(), agent: structuredClone(agent) }))
  const data = { owner: 'dsh-security-tasks-v1', tasks: [], runs }, limit = 4 * 1024 * 1024
  const serialize = () => JSON.stringify(data, null, 2) + '\n'
  while (Buffer.byteLength(serialize()) > limit - 100) runs.at(-1)!.agent.files.pop()
  const gap = limit - Buffer.byteLength(serialize())
  if (gap > 200) runs.at(-1)!.agent.files.push('f'.repeat(gap - 150))
  await writeFile(join(f.options.root, 'tasks.json'), serialize())
  const reopened = await SecurityTasks.open(f.options); services.push(reopened)
  await reopened.save({ ...f.config, name: 'Still writable and restartable' })
  expect((await reopened.state()).runs.length).toBeLessThan(21)
  expect(Buffer.byteLength(await readFile(join(f.options.root, 'tasks.json'), 'utf8'))).toBeLessThanOrEqual(limit)
  await reopened.close()
  const again = await SecurityTasks.open(f.options); services.push(again)
  expect((await again.state()).tasks[0]?.config.name).toBe('Still writable and restartable')
})
it('saves tasks without running them; detects stale updates and retains data across restart', async () => {
  const scanner = vi.fn(audit), f = await fixture({ audit: scanner })
  const task = await f.service.save(f.config)
  expect(scanner).not.toHaveBeenCalled()
  const updated = await f.service.save({ ...f.config, name: 'Changed' }, task.id, task.revision)
  expect(updated.revision).toBe(2)
  await expect(f.service.save(f.config, task.id, task.revision)).rejects.toThrow('task-changed')
  await f.service.close()
  const reopened = await SecurityTasks.open(f.options); services.push(reopened)
  expect((await reopened.state()).tasks[0]?.config.name).toBe('Changed')
})
it.each(['0.2.0', '0.11.0', '0.11.1', '0.11.2', '0.11.3', '0.11.4'])('runs the shared workflow and preserves archived %s reports', async version => {
  const f = await fixture(), task = await f.service.save(f.config)
  const run = await f.service.start(task.id, task.revision)
  await vi.waitFor(async () => { expect((await f.service.state()).runs.find(item => item.id === run.id)?.status).toBe('succeeded') })
  const state = await f.service.state(), finished = state.runs[0]!
  expect(finished.config).toEqual(f.config)
  expect(await f.service.report(finished.reportId!, 'html')).toContain('代码安全扫描报告')
  const reportFile = join(finished.reportRoot!, finished.reportId!, 'report.json')
  const saved = JSON.parse(await readFile(reportFile, 'utf8')); saved.pluginVersion = version; await writeFile(reportFile, JSON.stringify(saved))
  expect(await f.service.report(finished.reportId!, 'html')).toContain(version)
  await f.service.settings({ ...state.settings, reportDirectory: join(f.root, 'other-reports') })
  expect(await f.service.report(finished.reportId!, 'json')).toContain(finished.reportId)
  await f.service.remove(task.id, task.revision)
  expect((await f.service.state()).runs).toHaveLength(1)
  expect(await f.service.report(finished.reportId!, 'json')).toContain(finished.reportId)
})
it('cancels active and queued jobs, prevents duplicates, and never starts cancelled queued work', async () => {
  const started: string[] = []
  const scanner = vi.fn< typeof audit >(async options => {
    started.push(options.target)
    await new Promise<void>((_resolve, reject) => { options.signal.addEventListener('abort', () => reject(new Error('cancelled')), { once: true }) })
    return audit(options)
  })
  const f = await fixture({ audit: scanner }), first = await f.service.save(f.config), second = await f.service.save({ ...f.config, name: 'Second' })
  const run = await f.service.start(first.id, first.revision)
  await vi.waitFor(() => { expect(scanner).toHaveBeenCalledOnce() })
  await expect(f.service.start(first.id, first.revision)).rejects.toThrow('task-busy')
  const queued = await f.service.start(second.id, second.revision)
  await f.service.cancel(queued.id); await f.service.cancel(run.id)
  await vi.waitFor(async () => { expect((await f.service.state()).runs.every(item => item.status === 'cancelled')).toBe(true) })
  expect(scanner).toHaveBeenCalledOnce()
})
it('marks a missing engine as failed and still publishes its result', async () => {
  const f = await fixture(), task = await f.service.save({ ...f.config, engine: 'auto' })
  await f.service.start(task.id, task.revision)
  await vi.waitFor(async () => { expect((await f.service.state()).runs[0]?.status).toBe('failed') })
})
it('recovers unfinished records as interrupted and never silently resumes scans', async () => {
  const scanner = vi.fn(audit), f = await fixture({ audit: scanner }), task = await f.service.save(f.config)
  await f.service.close()
  const file = join(f.options.root, 'tasks.json'), store = JSON.parse(await readFile(file, 'utf8'))
  store.runs.push({ id: randomUUID(), taskId: task.id, config: task.config, status: 'running', phase: 'scanning', trigger: 'manual', createdAt: new Date().toISOString() })
  await writeFile(file, JSON.stringify(store))
  const next = await SecurityTasks.open(f.options); services.push(next)
  expect((await next.state()).runs[0]?.status).toBe('interrupted'); expect(scanner).not.toHaveBeenCalled()
})
it('holds an exclusive store lock and releases it only on owned shutdown', async () => {
  const f = await fixture()
  await expect(SecurityTasks.open(f.options)).rejects.toThrow('task-store-locked')
  await expect(readFile(join(f.options.root, '.tasks.lock'), 'utf8')).resolves.toMatch(/^\d+/u)
  await f.service.close()
  await expect(readFile(join(f.options.root, '.tasks.lock'))).rejects.toMatchObject({ code: 'ENOENT' })
})
it('validates UI inputs, requires explicit hook confirmation and denies arbitrary operations', async () => {
  const hook = vi.fn(async () => 'done'), f = await fixture({ hook }), handler = createSecurityRpc(Promise.resolve(f.service), vi.fn())
  const task = await f.service.save(f.config)
  const call = (method: string, value: unknown) => handler(method, value, new AbortController().signal)
  expect((await call('save', { config: { ...f.config, scope: 'diff', baseline: 'none' } })).ok).toBe(false)
  expect((await call('hook', { taskId: task.id, revision: task.revision, event: 'pre-commit', action: 'install', enforce: false, confirm: false })).ok).toBe(false)
  expect(hook).not.toHaveBeenCalled()
  expect((await call('hook', { taskId: task.id, revision: task.revision, event: 'pre-push', action: 'install', enforce: false, base: 'origin/main', confirm: true })).ok).toBe(true)
  expect(hook).toHaveBeenCalledWith(expect.objectContaining({ target: f.target, base: 'origin/main' }))
  expect((await call('exec', { command: 'anything' })).ok).toBe(false)
  expect((await call('report', { id: '../private', format: 'html' })).ok).toBe(false)
})
it('enables task-scoped edit checks without changing the legacy global setting', async () => {
  const scanner = vi.fn(audit), f = await fixture({ audit: scanner }), task = await f.service.save({ ...f.config, autoScan: true })
  expect(f.service.edited(f.target)).toBe(true)
  expect(f.service.edited('/unrelated')).toBe(false)
  await vi.waitFor(async () => { expect((await f.service.state()).runs[0]?.status).toBe('succeeded') }, { timeout: 4000 })
  expect((await f.service.state()).settings.autoScan).toBe(false)
  expect((await f.service.state()).runs[0]?.trigger).toBe('edit')
  await f.service.save({ ...task.config, autoScan: false }, task.id, task.revision)
  expect(f.service.edited(f.target)).toBe(false)
})

it('never prunes an active run when many later queued jobs are cancelled', async () => {
  const scanner = vi.fn<typeof audit>(async options => {
    await new Promise<void>((_resolve, reject) => options.signal.addEventListener('abort', () => reject(new Error('cancelled')), { once: true }))
    return audit(options)
  })
  const f = await fixture({ audit: scanner }), first = await f.service.save(f.config), second = await f.service.save({ ...f.config, name: 'Other task' })
  const active = await f.service.start(first.id, first.revision)
  await vi.waitFor(() => { expect(scanner).toHaveBeenCalledOnce() })
  for (let index = 0; index < 105; index++) { const queued = await f.service.start(second.id, second.revision); await f.service.cancel(queued.id) }
  const state = await f.service.state()
  expect(state.runs).toHaveLength(100)
  expect(state.runs.find(run => run.id === active.id)?.status).toBe('running')
  await f.service.cancel(active.id)
  await vi.waitFor(async () => { expect((await f.service.state()).runs.find(run => run.id === active.id)?.status).toBe('cancelled') })
})

it('leaves settings accessible when the report directory is invalid', async () => {
  const f = await fixture()
  const file = join(f.root, 'not-a-directory'); await writeFile(file, 'fixture')
  await f.service.settings({ ...(await f.service.state()).settings, reportDirectory: file })
  const state = await f.service.state()
  expect(state.settings.reportDirectory).toBe(file)
  expect(state.warnings).toContain('report-directory-unavailable')
  await f.service.settings({ ...state.settings, reportDirectory: join(f.root, 'fixed') })
  expect((await f.service.state()).warnings).toEqual([])
})

it('shutdown interrupts owned running work and preserves that reason after restart', async () => {
  const scanner = vi.fn<typeof audit>(async options => {
    await new Promise<void>((_resolve, reject) => options.signal.addEventListener('abort', () => reject(new Error('cancelled')), { once: true }))
    return audit(options)
  })
  const f = await fixture({ audit: scanner }), task = await f.service.save(f.config)
  await f.service.start(task.id, task.revision)
  await vi.waitFor(() => { expect(scanner).toHaveBeenCalledOnce() })
  await f.service.close()
  const next = await SecurityTasks.open(f.options); services.push(next)
  expect((await next.state()).runs[0]).toMatchObject({ status: 'interrupted', error: 'host-restarted' })
  expect(scanner).toHaveBeenCalledOnce()
})

it('does not remove a lock replaced by another owner during shutdown', async () => {
  const f = await fixture(), path = join(f.options.root, '.tasks.lock')
  await rm(path); await writeFile(path, 'different-owner\n')
  await expect(f.service.close()).rejects.toThrow('task-store-lock-changed')
  expect(await readFile(path, 'utf8')).toBe('different-owner\n')
})

it('recognizes official DSH mutations while excluding editor view calls', async () => {
  const { DEFAULT_EDIT_TOOLS, isConfiguredEdit } = await import('../src/hooks.js')
  expect(isConfiguredEdit('write', {}, DEFAULT_EDIT_TOOLS)).toBe(true)
  expect(isConfiguredEdit('edit', {}, DEFAULT_EDIT_TOOLS)).toBe(true)
  expect(isConfiguredEdit('str_replace_editor', { command: 'str_replace' }, DEFAULT_EDIT_TOOLS)).toBe(true)
  expect(isConfiguredEdit('str_replace_editor', { command: 'view' }, DEFAULT_EDIT_TOOLS)).toBe(false)
  expect(isConfiguredEdit('read', {}, DEFAULT_EDIT_TOOLS)).toBe(false)
  expect(isConfiguredEdit('security_audit', {}, ['security_audit'])).toBe(false)
})

it('syncs a workbench run to its new session and a conversation run to its existing session', async () => {
  const mirror = { start: vi.fn(async () => 'created-session'), publish: vi.fn(async () => {}) }
  const f = await fixture({ session: () => mirror })
  const task = await f.service.save({ ...f.config, syncSession: true })
  const first = await f.service.start(task.id, task.revision)
  await vi.waitFor(async () => expect((await f.service.state()).runs.find(run => run.id === first.id)?.phase).toBe('finished'))
  expect(mirror.start).toHaveBeenCalledOnce()
  expect((await f.service.state()).runs.find(run => run.id === first.id)).toMatchObject({ sessionId: 'created-session' })
  expect(mirror.publish.mock.calls.length).toBeGreaterThan(2)
  const second = await f.service.start(task.id, task.revision, 'conversation', 'current-session')
  await vi.waitFor(async () => expect((await f.service.state()).runs.find(run => run.id === second.id)?.phase).toBe('finished'))
  expect(mirror.start).toHaveBeenCalledOnce()
  expect((await f.service.state()).runs.find(run => run.id === second.id)).toMatchObject({ sessionId: 'current-session', trigger: 'conversation' })
})
it('keeps scan results when session synchronization fails and leaves disabled tasks unsynchronized', async () => {
  const mirror = { start: vi.fn(async () => { throw new Error('offline') }), publish: vi.fn(async () => {}) }
  const f = await fixture({ session: () => mirror })
  const plain = await f.service.save({ ...f.config, syncSession: false }), first = await f.service.start(plain.id, plain.revision)
  await vi.waitFor(async () => expect((await f.service.state()).runs.find(run => run.id === first.id)?.phase).toBe('finished'))
  expect(mirror.start).not.toHaveBeenCalled()
  expect((await f.service.state()).runs.find(run => run.id === first.id)?.sessionId).toBeUndefined()
  const watched = await f.service.save({ ...f.config, syncSession: true }), second = await f.service.start(watched.id, watched.revision)
  await vi.waitFor(async () => expect((await f.service.state()).runs.find(run => run.id === second.id)?.phase).toBe('finished'))
  expect((await f.service.state()).runs.find(run => run.id === second.id)).toMatchObject({ status: 'succeeded', sessionWarning: true, reportId: expect.any(String) })
})

it('publishes exactly one report after execution and separates partial coverage from failure', async () => {
  let release!: () => void, ready!: () => void
  const waiting = new Promise<void>(resolve => { ready = resolve })
  const gate = new Promise<void>(resolve => { release = resolve })
  const scanner: typeof audit = async options => {
    const result = await audit(options)
    result.report.engines[0]!.status = 'partial'
    ready(); await gate
    return result
  }
  const f = await fixture({ audit: scanner }), task = await f.service.save(f.config)
  await f.service.start(task.id, task.revision); await waiting
  try {
    const active = await f.service.state()
    expect(active.runs[0]!.reportId).toBeUndefined()
    expect(active.reports).toHaveLength(0)
  } finally { release() }
  await vi.waitFor(async () => expect((await f.service.state()).runs[0]!.phase).toBe('finished'))
  const state = await f.service.state()
  expect(state.runs[0]).toMatchObject({ status: 'succeeded', coverage: 'partial', resultSummary: { confirmed: 0, pending: 0, dismissed: 0 } })
  expect(state.reports).toHaveLength(1)
})

async function completedScan() {
  const f = await fixture(), task = await f.service.save(f.config)
  await f.service.start(task.id, task.revision)
  await vi.waitFor(async () => expect((await f.service.state()).runs[0]?.status).toBe('succeeded'))
  // Closing waits for final session publication before reopening the persisted terminal record.
  await f.service.close()
  const service = await SecurityTasks.open(f.options); services.push(service)
  const run = (await service.state()).runs[0]!
  return { ...f, service, task, run }
}
it('deletes a terminal record via RPC, preserves task/report and persists across restart', async () => {
  const f = await completedScan(), rpc = createSecurityRpc(Promise.resolve(f.service), vi.fn())
  expect(await rpc('removeRun', { id: f.run.id }, new AbortController().signal)).toEqual({ ok: true, value: null })
  const state = await f.service.state()
  expect(state.runs).toEqual([]); expect(state.tasks).toHaveLength(1); expect(state.reports).toHaveLength(1)
  expect(await f.service.report(f.run.reportId!, 'html')).toContain('代码安全扫描报告')
  await f.service.close()
  const reopened = await SecurityTasks.open(f.options); services.push(reopened)
  expect((await reopened.state()).runs).toEqual([])
  await expect(reopened.removeRun(f.run.id)).rejects.toThrow('run-not-found')
})
it('deletes report files and their UI links while preserving run results and other reports', async () => {
  const f = await completedScan(), { writeReport, readReport } = await import('../src/report.js')
  const file = join(f.run.reportRoot!, f.run.reportId!, 'report.json'), original = await readReport(file)
  const other = await writeReport(f.run.reportRoot!, { ...original, id: randomUUID() })
  const rpc = createSecurityRpc(Promise.resolve(f.service), vi.fn())
  expect(await rpc('removeReport', { id: f.run.reportId }, new AbortController().signal)).toEqual({ ok: true, value: null })
  await expect(readFile(file)).rejects.toMatchObject({ code: 'ENOENT' })
  await expect(readFile(join(f.run.reportRoot!, f.run.reportId!, 'report.html'))).rejects.toMatchObject({ code: 'ENOENT' })
  expect(await readFile(other.json, 'utf8')).toContain(original.source.label)
  const state = await f.service.state()
  expect(state.runs[0]).toEqual({ ...f.run, reportId: undefined }); expect(state.tasks).toHaveLength(1)
  expect(state.reports).toHaveLength(1)
  await f.service.close()
  const reopened = await SecurityTasks.open(f.options); services.push(reopened)
  expect((await reopened.state()).runs[0]?.reportId).toBeUndefined()
  await expect(reopened.removeReport(f.run.reportId!)).rejects.toThrow('report-not-found')
})
it('protects reports configured as baselines and permits deletion after changing the baseline', async () => {
  const f = await completedScan()
  const task = await f.service.save({ ...f.config, baseline: 'report', baselineId: f.run.reportId! }, f.task.id, f.task.revision)
  await expect(f.service.removeReport(f.run.reportId!)).rejects.toThrow('report-in-use')
  expect(await f.service.report(f.run.reportId!, 'json')).toContain(f.run.reportId)
  await f.service.save(f.config, task.id, task.revision)
  await f.service.removeReport(f.run.reportId!)
  expect((await f.service.state()).reports).toEqual([])
})
it('refuses active and queued records and protects a running snapshot baseline after task editing', async () => {
  const f = await completedScan(); await f.service.close()
  const scanner = vi.fn<typeof audit>(async options => {
    await new Promise<void>((_resolve, reject) => options.signal.addEventListener('abort', () => reject(new Error('cancelled')), { once: true }))
    return audit(options)
  })
  const service = await SecurityTasks.open({ ...f.options, audit: scanner }); services.push(service)
  const task = await service.save({ ...f.config, baseline: 'report', baselineId: f.run.reportId! }, f.task.id, f.task.revision)
  const run = await service.start(task.id, task.revision)
  await vi.waitFor(() => expect(scanner).toHaveBeenCalledOnce())
  await service.save(f.config, task.id, task.revision)
  const second = await service.save({ ...f.config, name: 'Queued' }), queued = await service.start(second.id, second.revision)
  await expect(service.removeRun(run.id)).rejects.toThrow('run-busy')
  await expect(service.removeRun(queued.id)).rejects.toThrow('run-busy')
  await expect(service.removeReport(f.run.reportId!)).rejects.toThrow('report-in-use')
  await service.close()
})
it('refuses unknown content, identity mismatch, symlinks and malformed deletion IDs', async () => {
  const f = await completedScan(), directory = join(f.run.reportRoot!, f.run.reportId!)
  const { symlink, rename } = await import('node:fs/promises')
  const extra = join(directory, 'my-notes.txt'); await writeFile(extra, 'keep')
  await expect(f.service.removeReport(f.run.reportId!)).rejects.toThrow('unsafe-report-delete')
  expect(await readFile(extra, 'utf8')).toBe('keep'); await rm(extra)
  const json = join(directory, 'report.json'), original = await readFile(json, 'utf8')
  await writeFile(json, JSON.stringify({ ...JSON.parse(original), id: randomUUID() }))
  await expect(f.service.removeReport(f.run.reportId!)).rejects.toThrow('unsafe-report-delete')
  await writeFile(json, original)
  const html = join(directory, 'report.html'), outside = join(f.root, 'keep.html')
  await rename(html, outside); await symlink(outside, html)
  await expect(f.service.removeReport(f.run.reportId!)).rejects.toThrow('unsafe-report-delete')
  expect(await readFile(outside, 'utf8')).toContain('代码安全扫描报告')
  await rm(html); await rename(outside, html)
  const moved = join(f.root, 'owned-report'); await rename(directory, moved); await symlink(moved, directory)
  await expect(f.service.removeReport(f.run.reportId!)).rejects.toThrow('unsafe-report-delete')
  expect(await readFile(join(moved, 'report.json'), 'utf8')).toBe(original)
  const rpc = createSecurityRpc(Promise.resolve(f.service), vi.fn())
  for (const endpoint of ['removeRun', 'removeReport']) expect(await rpc(endpoint, { id: '../outside' }, new AbortController().signal)).toMatchObject({ ok: false })
})
it('restores the report and run links when history persistence fails', async () => {
  const f = await completedScan(), { rename } = await import('node:fs/promises')
  const store = join(f.options.root, 'tasks.json'), backup = join(f.options.root, 'tasks.backup')
  await rename(store, backup); await mkdir(store)
  try {
    await expect(f.service.removeReport(f.run.reportId!)).rejects.toThrow()
    expect((await f.service.state()).runs[0]?.reportId).toBe(f.run.reportId)
    expect(await f.service.report(f.run.reportId!, 'html')).toContain('代码安全扫描报告')
  } finally { await rm(store, { recursive: true }); await rename(backup, store) }
})

it('exposes the model catalog separately from polling and preserves explicit/default choices on save', async () => {
  const models = vi.fn(async () => ({ models: [{ provider: 'a/b', providerName: 'Work', model: 'm/n', name: 'Model' }], partial: false }))
  const f = await fixture({ models }), rpc = createSecurityRpc(Promise.resolve(f.service), vi.fn())
  await f.service.state()
  expect(models).not.toHaveBeenCalled()
  expect(await rpc('models', {}, new AbortController().signal)).toMatchObject({ ok: true, value: { models: [{ provider: 'a/b', model: 'm/n' }], partial: false } })
  expect(await rpc('models', { apiKey: 'no' }, new AbortController().signal)).toMatchObject({ ok: false })
  const task = await f.service.save({ ...f.config, agent: { ...f.config.agent, enabled: true, provider: 'a/b', model: 'm/n' } })
  expect((await f.service.state()).tasks[0]?.config.agent).toMatchObject({ provider: 'a/b', model: 'm/n' })
  const cleared = await f.service.save({ ...task.config, agent: { ...task.config.agent, provider: '', model: '' } }, task.id, task.revision)
  expect(cleared.config.agent).toMatchObject({ enabled: true, provider: '', model: '' })
})

async function abandonedStore() {
  const f = await fixture()
  await f.service.save(f.config)
  await f.service.close()
  const child = spawnSync(process.execPath, ['-e', ''], { stdio: 'ignore' })
  expect(child.status).toBe(0)
  const path = join(f.options.root, '.tasks.lock'), owner = String(child.pid) + '\n'
  await writeFile(path, owner, { mode: 0o600 })
  return { ...f, path, owner }
}
it('recovers an exited process lock while preserving saved tasks', async () => {
  const f = await abandonedStore()
  const next = await SecurityTasks.open(f.options); services.push(next)
  expect((await next.state()).tasks[0]?.config).toEqual(f.config)
  expect(await readFile(f.path, 'utf8')).toBe(String(process.pid) + '\n')
  await next.close()
  await expect(readFile(f.path)).rejects.toMatchObject({ code: 'ENOENT' })
})
it('allows only one concurrent owner when recovering a stale lock', async () => {
  const f = await abandonedStore()
  const results = await Promise.allSettled(Array.from({ length: 8 }, () => SecurityTasks.open(f.options)))
  const winners = results.filter(result => result.status === 'fulfilled')
  for (const winner of winners) services.push(winner.value)
  expect(winners).toHaveLength(1)
  expect(await readFile(f.path, 'utf8')).toBe(String(process.pid) + '\n')
  for (const result of results) if (result.status === 'rejected') expect(result.reason.message).toBe('task-store-locked')
})
it.each(['', 'unknown-owner\n', '0\n', '-1\n', '2147483648\n'])('preserves unknown lock %j', async owner => {
  const f = await abandonedStore(); await writeFile(f.path, owner)
  await expect(SecurityTasks.open(f.options)).rejects.toThrow('task-store-locked')
  expect(await readFile(f.path, 'utf8')).toBe(owner)
})
it('preserves locks when process inspection is denied', async () => {
  const f = await abandonedStore()
  const kill = vi.spyOn(process, 'kill').mockImplementation(() => { throw Object.assign(new Error('denied'), { code: 'EPERM' }) })
  try {
    await expect(SecurityTasks.open(f.options)).rejects.toThrow('task-store-locked')
    expect(await readFile(f.path, 'utf8')).toBe(f.owner)
  } finally { kill.mockRestore() }
})
it('refuses symlink locks and an existing recovery guard', async () => {
  const f = await abandonedStore(), target = join(f.root, 'foreign-lock')
  await writeFile(target, f.owner); await rm(f.path); await symlink(target, f.path)
  await expect(SecurityTasks.open(f.options)).rejects.toThrow('task-store-locked')
  expect(await readFile(target, 'utf8')).toBe(f.owner)
  await rm(f.path); await writeFile(f.path, f.owner)
  const guard = join(f.options.root, '.tasks-recovery.lock')
  await writeFile(guard, 'unknown owner')
  await expect(SecurityTasks.open(f.options)).rejects.toThrow('task-store-locked')
  expect(await readFile(guard, 'utf8')).toBe('unknown owner')
  expect(await readFile(f.path, 'utf8')).toBe(f.owner)
})

it('rescans the immutable run configuration after edits and retains comparison across report-root changes', async () => {
  const f = await fixture(), task = await f.service.save(f.config)
  const first = await f.service.start(task.id, task.revision)
  await vi.waitFor(async () => { expect((await f.service.state()).runs.find(run => run.id === first.id)?.reportId).toBeTruthy() })
  const previous = (await f.service.state()).runs[0]!
  await f.service.save({ ...f.config, name: 'Edited task', secrets: true }, task.id, task.revision)
  await f.service.settings({ ...f.options.settings(), reportDirectory: join(f.root, 'new-reports') })
  const next = await f.service.rescan(previous.reportId!)
  expect(next.config).toEqual(f.config)
  expect(next.previousReportId).toBe(previous.reportId)
  await vi.waitFor(async () => { expect((await f.service.state()).runs[0]?.reportId).toBeTruthy() })
  const current = (await f.service.state()).runs[0]!
  expect((await f.service.reportActions(current.reportId!)).comparison).toMatchObject({ previousId: previous.reportId, comparable: false })
  await f.service.removeRun(previous.id)
  expect(await f.service.report(previous.reportId!, 'json')).toContain(previous.reportId)
  await f.service.removeReport(previous.reportId!)
  expect((await f.service.reportActions(current.reportId!)).comparison).toBeUndefined()
})

it('protects a comparison report while its rescan is active', async () => {
  let hold = false
  const f = await fixture({ audit: async options => {
    if (hold) await new Promise<void>((_, reject) => options.signal.addEventListener('abort', () => reject(new Error('cancelled')), { once: true }))
    return audit(options)
  } }), task = await f.service.save(f.config)
  await f.service.start(task.id, task.revision)
  await vi.waitFor(async () => { expect((await f.service.state()).runs[0]?.reportId).toBeTruthy() })
  const previous = (await f.service.state()).runs[0]!
  hold = true
  await f.service.rescan(previous.reportId!)
  await expect(f.service.removeReport(previous.reportId!)).rejects.toThrow('report-in-use')
  await expect(f.service.rescan(previous.reportId!)).rejects.toThrow('task-busy')
})

it('persists a repair identity before admission and reuses it after retries and restart', async () => {
  const create = vi.fn(async () => ({})), prompt = vi.fn(async (..._args: unknown[]) => ({ accepted: true })), rename = vi.fn(async () => ({})), attachSession = vi.fn()
  const native = { sessionController: { create, prompt, rename }, workspaceRegistry: { create: async () => ({ attachSession }) } } as never
  const f = await fixture({ agentContext: () => ({ native }), audit: async options => {
    const result = await audit(options)
    result.report.findings = [{ id: 'selected', fingerprint: 'fp', engine: 'semgrep', rule: 'eval', file: 'app.py', line: 1, title: 'Candidate', cwe: '', severity: 'high', status: 'needs-review', change: 'unknown', evidence: 'evidence', recommendation: 'review', verification: 'not verified' }]
    return result
  } }), task = await f.service.save(f.config)
  await f.service.start(task.id, task.revision)
  await vi.waitFor(async () => { expect((await f.service.state()).runs[0]?.reportId).toBeTruthy() })
  const run = (await f.service.state()).runs[0]!, id = run.reportId!
  expect((await f.service.reportActions(id)).repairable).toBe(true)
  await expect(f.service.repair(id, ['unknown'], 'local')).rejects.toThrow('unknown-finding')
  prompt.mockRejectedValueOnce(new Error('connection lost'))
  await expect(f.service.repair(id, ['selected'], 'local')).rejects.toThrow('connection lost')
  const [result, concurrent] = await Promise.all([f.service.repair(id, ['selected'], 'local'), f.service.repair(id, ['selected'], 'local')])
  expect(concurrent).toEqual(result)
  expect(prompt.mock.calls[0]![0]).toEqual(prompt.mock.calls[1]![0])
  expect(create.mock.calls[0]).toEqual(create.mock.calls[1])
  expect(result.sessionId).toMatch(/^security-repair-/u)
  await f.service.close()
  const reopened = await SecurityTasks.open(f.options); services.push(reopened)
  expect((await reopened.reportActions(id)).run?.repair).toMatchObject({ sessionId: result.sessionId, admitted: true })
  expect(await reopened.repair(id, ['selected'], 'local')).toEqual(result)
  expect(prompt).toHaveBeenCalledTimes(2)
  const rpc = createSecurityRpc(Promise.resolve(reopened), vi.fn())
  expect(await rpc('repair', { id, findingIds: [] }, new AbortController().signal)).toMatchObject({ ok: false })
})

it('isolates PR repairs, records only their own delivery URL, and rescans the repair branch', async () => {
  const create = vi.fn(async (..._args: unknown[]) => ({})), prompt = vi.fn(async (..._args: unknown[]) => ({ accepted: true }))
  const native = { sessionController: { create, prompt, rename: vi.fn() }, workspaceRegistry: { create: async () => ({ attachSession: vi.fn() }) } } as never
  const f = await fixture({ agentContext: () => ({ native }), audit: async options => {
    const result = await audit(options)
    result.report.findings = [{ id: 'selected', fingerprint: 'fp', engine: 'semgrep', rule: 'eval', file: 'app.py', line: 1, title: 'Candidate', cwe: '', severity: 'high', status: 'needs-review', change: 'unknown', evidence: 'evidence', recommendation: 'review', verification: 'not verified' }]
    return result
  } })
  const git = (...args: string[]) => { const result = spawnSync('/usr/bin/git', ['-c', 'core.hooksPath=/dev/null', ...args], { cwd: f.target, encoding: 'utf8' }); expect(result.status, result.stderr).toBe(0); return result.stdout.trim() }
  git('init', '-b', 'main'); git('config', 'user.email', 'fixture@example.invalid'); git('config', 'user.name', 'Fixture'); git('add', '.'); git('commit', '-m', 'fixture'); git('remote', 'add', 'origin', 'git@github.com:example/project.git')
  const task = await f.service.save(f.config); await f.service.start(task.id, task.revision)
  await vi.waitFor(async () => { expect((await f.service.state()).runs[0]?.reportId).toBeTruthy() })
  const original = (await f.service.state()).runs[0]!, id = original.reportId!, before = await f.service.reportActions(id)
  expect(before.repairMode).toBe('pr'); expect(before.prPreview?.base).toBe('main')
  const repaired = await f.service.repair(id, ['selected'], 'pr', before.prPreview!.revision)
  const actions = await f.service.reportActions(id), workspace = actions.run!.repair!.workspace!
  expect(create.mock.calls[0]![0]).toEqual({ sessionId: repaired.sessionId, cwd: workspace.target })
  expect(JSON.stringify(prompt.mock.calls)).toContain('security_record_repair_delivery')
  expect(JSON.stringify(prompt.mock.calls)).toContain('点击修复按钮本身不授权这些交付动作')
  expect(JSON.stringify(prompt.mock.calls)).toContain('没有远端、工具或权限时，继续在已创建的本地修复分支解决问题')
  await expect(f.service.repair(id, ['selected'], 'local')).rejects.toThrow('repair-exists')
  await expect(f.service.recordRepairDelivery('another-session', 'https://github.com/example/project/pull/1')).rejects.toThrow('repair-unavailable')
  await expect(f.service.recordRepairDelivery(repaired.sessionId, 'https://github.com/other/project/pull/1')).rejects.toThrow('repair-pr-url')
  await f.service.recordRepairDelivery(repaired.sessionId, 'https://github.com/example/project/pull/1')
  await writeFile(join(workspace.target, 'app.py'), 'print("fixed")\n')
  expect(await readFile(join(f.target, 'app.py'), 'utf8')).toBe('print("test")\n')
  expect(await f.service.repair(id, ['selected'], 'pr')).toEqual(repaired)
  expect(prompt).toHaveBeenCalledTimes(1)
  const next = await f.service.rescan(id)
  expect(next.config.target).toBe(workspace.target)
  expect(next.repairSource?.prUrl).toBe('https://github.com/example/project/pull/1')
  await vi.waitFor(async () => { expect((await f.service.state()).runs.find(run => run.id === next.id)?.reportId).toBeTruthy() })
  const completed = (await f.service.state()).runs.find(run => run.id === next.id)!
  const saved = JSON.parse(await f.service.report(completed.reportId!, 'json'))
  expect(saved.source.identity).toBe(workspace.sourceIdentity)
  expect(git('branch', '--show-current')).toBe('main')
})
