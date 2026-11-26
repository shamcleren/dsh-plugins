import { Context } from '@deepseek-ai/cordis'
import { createServer } from 'node:http'
import { expect, it, vi } from 'vitest'
import { createHostApi, type HostSessionEvent } from '../../src/adapters/wechat/host-api.js'
import { WeChatConversationRouter } from '../../src/adapters/wechat/router.js'
import { sendMessage } from '../../src/adapters/wechat/api.js'

const sourceReply = '## 计划\n\n- 上海\n- 南京\n\n| 项目 | 状态 |\n| --- | --- |\n| 返程 | 已确认 |'
const displayedReply = '【计划】\n- 上海\n- 南京\n- 项目：返程；状态：已确认'

it.each([
  { delivery: 'snapshot', receipt: '{"ret":0}' },
  { delivery: 'live', receipt: '{"ret":0}' },
  { delivery: 'snapshot', receipt: '{"message_id":9223372036854775807}' },
  { delivery: 'live', receipt: '{"message_id":9223372036854775807}' },
])('delivers a $delivery turn with iLink receipt $receipt when channel mux events are absent', async ({ delivery, receipt }) => {
  const captured: Array<{ path: string; authorization: string | undefined; body: unknown }> = []
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = []
    for await (const chunk of request) chunks.push(Buffer.from(chunk))
    captured.push({ path: request.url!, authorization: request.headers.authorization,
      body: JSON.parse(Buffer.concat(chunks).toString()) })
    response.writeHead(200, { 'content-type': 'application/json' }); response.end(receipt)
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Missing fixture address')
  const baseUrl = `http://127.0.0.1:${address.port}`
  const ctx = new Context(), carrier = { [Context.filter]: () => false }
  let router!: WeChatConversationRouter
  let events: HostSessionEvent[] = []
  let admitted!: () => void
  const admission = new Promise<void>(resolve => { admitted = resolve })
  let followerStopped = false
  const prompt = vi.fn(async (request: { sessionId: string; requestId: string }) => {
    events = [
      { type: 'agent/inbox/spliced', seq: 0, data: { inserted: [{ source: { rpcId: request.requestId } }] } },
      { type: 'turn/start', seq: 1, data: { turn: 1 } },
      { type: 'step/start', seq: 2, data: { turn: 1 } },
      { type: 'assistant/message', seq: 3, data: { turn: 1, message: { content: [{ type: 'text', text: sourceReply }] } } },
      { type: 'turn/end', seq: 4, data: { turn: 1, reason: { kind: 'completed' } } },
    ]
    for (const event of events) {
      ctx.emit(carrier as never, 'session/event', { id: 'foreign' } as never,
        { ...event, data: { message: { content: [{ type: 'text', text: 'foreign secret' }] } } } as never)
    }
    admitted()
    return { accepted: true as const }
  })
  const follow = vi.fn(async function* (_request: unknown, signal: AbortSignal) {
    try {
      if (delivery === 'snapshot') await admission
      yield { type: 'snapshot', cursor: delivery === 'snapshot' ? 4 : -1,
        records: delivery === 'snapshot' ? events.map(event => ({ type: 'event', event })) : [], hasMore: false }
      if (delivery === 'live') {
        await admission
        for (const event of events) yield { type: 'event', event }
      }
      if (!signal.aborted) await new Promise<void>(resolve => { signal.addEventListener('abort', () => resolve(), { once: true }) })
    } finally { followerStopped = true }
  })
  ctx.provide('sessionController', { create: async () => ({ sessionId: 'fixture-session' }),
    inspect: async () => ({ events: [] }), prompt, follow } as never)
  ctx.provide('workspaceRegistry', { list: () => [], archivedSessionIds: [] } as never)
  let api!: ReturnType<typeof createHostApi>
  await ctx.plugin({ apply(inner: Context) { api = createHostApi(inner, id => router?.routesSession(id) === true) } })
  const errors = vi.fn()
  router = new WeChatConversationRouter(api, {
    sendText: (userId, text, contextToken) => sendMessage({ baseUrl, token: 'fixture-token', userId,
      ...(contextToken === undefined ? {} : { contextToken }), item: { type: 1, text_item: { text } } }),
    sendImage: vi.fn(), sendFile: vi.fn(), sendVideo: vi.fn(), typing: vi.fn(),
  }, { info: vi.fn(), warn: vi.fn(), error: errors, debug: vi.fn(), success: vi.fn() } as never,
  { adminUsers: [], thinkingText: 'thinking', turnTimeoutMs: 5000, mediaMaxBytes: 1024, sendTyping: false },
  { bindings: { current: (_key, fallback) => fallback, list: (_key, fallback) => [fallback], set: async () => undefined },
    defaultWorkspace: { workspaceId: 'fixture-workspace', path: '/fixture', title: 'WeChat', sessionIds: [] } })
  try {
    router.start()
    await router.accept({ accountId: 'fixture-account', messageId: 'fixture-message', userId: 'fixture-peer',
      contextToken: 'fixture-context', content: [{ type: 'text', text: 'hello' }] })
    await vi.waitFor(() => { expect(captured).toHaveLength(1) })
    expect(prompt).toHaveBeenCalledOnce()
    expect(follow).toHaveBeenCalledWith({ address: { kind: 'session', sessionId: 'fixture-session' }, maxMessages: 100 }, expect.any(AbortSignal))
    expect(followerStopped).toBe(true)
    expect(captured[0]).toMatchObject({ path: '/ilink/bot/sendmessage', authorization: 'Bearer fixture-token',
      body: { msg: { to_user_id: 'fixture-peer', context_token: 'fixture-context', message_state: 2,
        item_list: [{ type: 1, text_item: { text: displayedReply } }] } } })
    expect(events[3]?.data).toMatchObject({ message: { content: [{ type: 'text', text: sourceReply }] } })
    expect(JSON.stringify(captured)).not.toContain('foreign secret')
    expect(errors).not.toHaveBeenCalled()
  } finally {
    await router.stop(); await ctx.fiber.dispose()
    await new Promise<void>(resolve => server.close(() => resolve()))
  }
})
