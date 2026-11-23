import { randomUUID } from 'node:crypto'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, afterEach, expect, it, vi } from 'vitest'
import { apply } from '../src/agent-workspace.ts'
import { AgentBrowser } from '../src/agent-browser.ts'
import { Question } from '../src/agent-contract.ts'

const transport = vi.hoisted(() => ({ handler: undefined }))
vi.mock('../src/web.ts', () => ({ registerRpc: (_ctx, _channel, handler) => { transport.handler = handler } }))
let directory, tools, listeners, disposers, prompt, ctx, signal
const sessionId = 'review-fixture'
const exec = () => ({ agent: { session: { id: sessionId } }, signal, concludeTurn: vi.fn() })
const call = (method, payload = {}) => transport.handler(method, { sessionId, ...payload }, signal)
const state = async () => structuredClone((await call('state')).value)
const ask = (name = 'message') => tools.get('saas_ask').execute({ title: 'Input', fields: [{ name, label: name }] }, exec())
const idle = () => listeners.get('agent/status')({ agent: { id: sessionId }, status: 'idle' })
const observed = (records = [], text = '') => ({ id: randomUUID(), url: 'https://portal.example.test/agents', title: 'Fixture', text, controls: [], records, recordsState: records.length ? 'ready' : 'unavailable', capturedAt: new Date().toISOString(), truncated: false })
const row = (name, id = 'r0') => ({ name, id, version: '1', type: 'chat', description: '', tags: [], actions: [] })
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b }); return { promise, resolve, reject } }
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'saas-state-')); tools = new Map(); listeners = new Map(); disposers = []; prompt = vi.fn(async () => {}); signal = new AbortController().signal
  const service = { sessionState: () => undefined }
  ctx = { get: () => service, on: (event, fn) => listeners.set(event, fn), agents: { get: () => undefined }, sessionController: { prompt }, effect: fn => disposers.push(fn()), tools: { register: tool => tools.set(tool.name, tool) }, webServer: { register: () => () => {} }, systemPrompt: { section: () => {} } }
  const siteFile = join(directory, 'site.json')
  await writeFile(siteFile, JSON.stringify({ name: 'Fixture', url: 'https://portal.example.test/agents', allowedOrigins: ['https://portal.example.test'], emptyText: 'Empty', selectors: Object.fromEntries(['search', 'results', 'card', 'name', 'type', 'version', 'tags', 'description'].map(key => [key, '.' + key])) }))
  await apply(ctx, { siteFile })
})
afterEach(async () => { vi.restoreAllMocks(); for (const dispose of disposers.reverse()) if (typeof dispose === 'function') await dispose(); await rm(directory, { recursive: true, force: true }) })

it('allows only one simultaneous form submission and releases queued state when a prose-only turn ends', async () => {
  await ask(); const question = (await state()).question
  const gate = deferred(); prompt.mockReturnValue(gate.promise)
  const first = call('answer', { questionId: question.id, answers: { message: 'hello' } })
  const duplicate = call('answer', { questionId: question.id, answers: { message: 'hello' } })
  const deliveries = prompt.mock.calls.length
  gate.resolve(); const replies = await Promise.all([first, duplicate])
  expect(deliveries).toBe(1); expect(replies[0].ok).toBe(true); expect(replies[1].ok).toBe(false)
  expect((await state()).phase).toBe('queued')
  idle(); expect((await state()).phase).toBe('ready')
  expect((await state()).question).toBeUndefined()
})

it('preserves a form when delivery fails and does not clear a new form created during delivery', async () => {
  await ask(); const question = (await state()).question
  prompt.mockRejectedValueOnce(new Error('queue-unavailable'))
  expect((await call('answer', { questionId: question.id, answers: { message: 'hello' } })).ok).toBe(false)
  expect((await state())).toMatchObject({ phase: 'awaiting_input', question })
  prompt.mockImplementationOnce(async () => { await ask('next_message') })
  expect((await call('answer', { questionId: question.id, answers: { message: 'hello' } })).ok).toBe(true)
  expect((await state()).question.fields[0].name).toBe('next_message')
  idle(); expect((await state()).phase).toBe('awaiting_input')
  const requestIds = prompt.mock.calls.map(([request]) => request.requestId)
  expect(requestIds[0]).toBe(requestIds[1])
})

it('returns to the pending form after human takeover without enqueuing a duplicate task', async () => {
  vi.spyOn(AgentBrowser.prototype, 'ready', 'get').mockReturnValue(true)
  vi.spyOn(AgentBrowser.prototype, 'login', 'get').mockReturnValue(false)
  await ask(); const question = (await state()).question
  expect((await call('takeover')).ok).toBe(true)
  const human = await state(); expect(human.phase).toBe('human')
  expect((await call('resume', { revision: human.revision })).ok).toBe(true)
  expect(await state()).toMatchObject({ phase: 'awaiting_input', question })
  expect(prompt).not.toHaveBeenCalled()
})

it('retains list and details across navigation and does not select a different row with a reused id', async () => {
  const listing = observed([row('First')]), detail = observed([], 'Configuration of First'), other = observed([row('Second')])
  const browser = vi.spyOn(AgentBrowser.prototype, 'act').mockResolvedValueOnce(listing).mockResolvedValueOnce(detail).mockResolvedValueOnce(other)
  await tools.get('saas_browser').execute({ action: 'observe' }, exec())
  expect((await call('select', { observationId: listing.id, recordId: 'r0' })).ok).toBe(true)
  await tools.get('saas_browser').execute({ action: 'observe' }, exec())
  await tools.get('saas_present').execute({ view: 'details' }, exec())
  expect(await state()).toMatchObject({ listing, details: detail, selected: row('First') })
  expect((await call('view', { view: 'table' })).ok).toBe(true)
  expect((await call('view', { view: 'details' })).ok).toBe(true)
  await tools.get('saas_browser').execute({ action: 'observe' }, exec())
  expect((await state()).selectedId).toBeUndefined()
  expect((await state()).selected.name).toBe('First')
  expect(browser).toHaveBeenCalledTimes(3)
})

it('does not allow selecting while the agent is still planning between browser actions', async () => {
  const listing = observed([row('First')]); vi.spyOn(AgentBrowser.prototype, 'act').mockResolvedValue(listing)
  await tools.get('saas_browser').execute({ action: 'observe' }, exec())
  listeners.get('agent/status')({ agent: { id: sessionId }, status: 'running' })
  expect((await call('select', { observationId: listing.id, recordId: 'r0' })).ok).toBe(false)
  expect(prompt).not.toHaveBeenCalled()
  idle(); expect((await call('select', { observationId: listing.id, recordId: 'r0' })).ok).toBe(true)
})

it('provides a usable unconfigured state and rejects duplicate form field names', async () => {
  await apply(ctx, {})
  expect(await state()).toMatchObject({ configured: false, phase: 'ready', executions: [] })
  expect(Question.safeParse({ id: randomUUID(), title: 'Form', fields: [{ name: 'same', label: 'One' }, { name: 'same', label: 'Two' }] }).success).toBe(false)
})

it('retires an old form when the user continues through the native conversation', async () => {
  await ask(); expect((await state()).question).toBeDefined()
  vi.spyOn(AgentBrowser.prototype, 'act').mockResolvedValue(observed([row('First')]))
  await tools.get('saas_browser').execute({ action: 'observe' }, exec())
  expect(await state()).toMatchObject({ phase: 'ready' })
  expect((await state()).question).toBeUndefined()
})

it('reports model authentication errors without dropping results or misreporting idle as success', async () => {
  const listing = observed([row('First')]); vi.spyOn(AgentBrowser.prototype, 'act').mockResolvedValue(listing)
  await tools.get('saas_browser').execute({ action: 'observe' }, exec())
  listeners.get('session/event')({ id: sessionId }, { type: 'turn/end', data: { reason: { kind: 'error', error: { code: 'AUTH', message: 'sensitive-provider-error' } } } })
  idle()
  const current = await state()
  expect(current).toMatchObject({ phase: 'failed', error: 'model-auth-required', listing })
  expect(JSON.stringify(current)).not.toContain('sensitive-provider-error')
  listeners.get('agent/status')({ agent: { id: sessionId }, status: 'running' })
  expect(await state()).toMatchObject({ phase: 'queued', agentRunning: true })
  expect((await state()).error).toBeUndefined()
})

it('finds a model failure that finished before the workbench was opened', async () => {
  ctx.agents.get = () => ({ status: 'idle', session: { seq: 4, snapshotEvents: () => [{ type: 'turn/end', data: { reason: { kind: 'error', error: { code: 'AUTH', message: 'expired' } } } }] } })
  expect(await state()).toMatchObject({ phase: 'failed', error: 'model-auth-required' })
})

it.each([{ kind: 'error', error: { code: 'UNKNOWN', message: 'private' } }, { kind: 'aborted', reason: { kind: 'legacy' } }, { kind: 'blocked' }, { kind: 'max-tokens' }])('surfaces a stopped turn without discarding a pending form: $kind', async reason => {
  await ask(); const question = (await state()).question
  listeners.get('session/event')({ id: sessionId }, { type: 'turn/end', data: { reason } })
  expect(await state()).toMatchObject({ phase: 'awaiting_input', question, error: reason.kind === 'error' ? 'agent-turn-failed' : 'agent-turn-interrupted' })
})
