import { Context } from '@deepseek-ai/cordis'
import { expect, it, vi } from 'vitest'
import { createHostApi } from '../src/host-api.js'

it('uses public controllers for prompt identity, workspace rename and event routing', async () => {
  const ctx = new Context(), active = new Set(['owned'])
  const prompt = vi.fn(async () => ({ accepted: true as const }))
  const workspace = { id: 'workspace-fixture', path: '/tmp', title: 'Before', sessionIds: [], setTitle: vi.fn(async (title: string) => { workspace.title = title }) }
  ctx.provide('sessionController', { prompt } as never)
  ctx.provide('workspaceRegistry', { get: () => workspace } as never)
  const fiber = await ctx.plugin({ apply(inner: Context) { inner.provide('channelFixture', createHostApi(inner, id => active.has(id))) } })
  const api = fiber.ctx.get('channelFixture') as ReturnType<typeof createHostApi>
  const abort = new AbortController(), stream = api.events.mux({ rpcId: 'stream', payload: {} }, abort.signal)[Symbol.asyncIterator]()
  try {
    const next = stream.next()
    ctx.emit('session/event', { id: 'foreign' } as never, { type: 'turn/start', seq: 0, data: {} } as never)
    ctx.emit('session/event', { id: 'owned' } as never, { type: 'turn/start', seq: 1, data: {} } as never)
    expect((await next).value).toMatchObject({ payload: { sessionId: 'owned' } })
    await expect(api.sessions.prompt({ rpcId: 'durable-prompt', payload: { sessionId: 'owned', mode: 'queue', content: [{ type: 'text', text: '你好' }] } })).resolves.toMatchObject({ result: { ok: true, value: { accepted: true } } })
    expect(prompt).toHaveBeenCalledWith(expect.objectContaining({ requestId: 'durable-prompt', sessionId: 'owned', mode: 'queue' }), expect.any(AbortSignal))
    await expect(api.workspace.rename({ rpcId: 'rename', payload: { workspaceId: workspace.id, title: 'After' } })).resolves.toMatchObject({ result: { value: { workspace: { title: 'After' } } } })
    expect(workspace.setTitle).toHaveBeenCalledWith('After')
  } finally { abort.abort(); await stream.return?.(); await ctx.fiber.dispose() }
})

it('answers native questions in the active channel only and aborts pending questions on unload', async () => {
  const ctx = new Context(), active = new Set(['owned'])
  ctx.provide('sessionController', {} as never); ctx.provide('workspaceRegistry', {} as never)
  let api!: ReturnType<typeof createHostApi>
  const fiber = await ctx.plugin({ apply(inner: Context) { api = createHostApi(inner, id => active.has(id)) } })
  const abort = new AbortController(), stream = api.events.mux({ rpcId: 'stream', payload: {} }, abort.signal)[Symbol.asyncIterator]()
  const request = { agent: { id: 'owned' }, questions: [{ id: 'confirm', question: '选哪个？' }] } as never
  try {
    const frame = stream.next()
    const answered = ctx.waterfall('user-questions/request', request, async () => { throw new Error('must stay in channel') })
    const item = (await frame).value!
    expect(item.payload.type).toBe('question/requested')
    expect(await api.respond({ type: 'client-response', rpcId: item.rpcId, result: { ok: true, value: { answer: { answers: [{ id: 'confirm', selected: [], custom: '继续' }] } } } })).toEqual({ accepted: true })
    expect(await answered).toEqual({ answers: [{ id: 'confirm', selected: [], custom: '继续' }] })
    expect((await stream.next()).value).toMatchObject({ payload: { outcome: 'answered' } })
    active.clear()
    await expect(ctx.waterfall('user-questions/request', request, async () => ({ answers: [] }))).resolves.toEqual({ answers: [] })
    active.add('owned')
    const frame2 = stream.next()
    const cancelled = ctx.waterfall('user-questions/request', request, async () => ({ answers: [] }))
    const rejection = expect(cancelled).rejects.toBeDefined()
    await frame2
    await fiber.dispose()
    await rejection
  } finally { abort.abort(); await stream.return?.(); await ctx.fiber.dispose() }
})

it('answers an agent-scoped question from a sibling plugin fiber', async () => {
  const ctx = new Context(), active = new Set(['owned'])
  ctx.provide('sessionController', {} as never); ctx.provide('workspaceRegistry', {} as never)
  let api!: ReturnType<typeof createHostApi>
  const fiber = await ctx.plugin({ apply(inner: Context) { api = createHostApi(inner, id => active.has(id)) } })
  const abort = new AbortController(), stream = api.events.mux({ rpcId: 'stream', payload: {} }, abort.signal)[Symbol.asyncIterator]()
  const request = { agent: { id: 'owned' }, questions: [{ id: 'confirm', question: '选哪个？' }] } as never
  const thisArg = { [Context.filter]: () => false }
  try {
    const frame = stream.next()
    const answered = ctx.waterfall(thisArg as never, 'user-questions/request', request, async () => { throw new Error('must stay in channel') })
    const item = (await frame).value!
    expect(item.payload.type).toBe('question/requested')
    expect(await api.respond({ type: 'client-response', rpcId: item.rpcId, result: { ok: true, value: { answer: { answers: [{ id: 'confirm', selected: [], custom: '继续' }] } } } })).toEqual({ accepted: true })
    expect(await answered).toEqual({ answers: [{ id: 'confirm', selected: [], custom: '继续' }] })
  } finally { abort.abort(); await stream.return?.(); await fiber.dispose(); await ctx.fiber.dispose() }
})
