import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { ConversationBindings } from '../../src/adapters/wechat/bindings.js'
import { WeChatConversationRouter } from '../../src/adapters/wechat/router.js'
import { conversationKeyFor, sessionIdFor, type WeChatInboundMessage } from '../../src/adapters/wechat/inbound.js'
import type { HostApiProxy, HostSessionSummary, HostWorkspace } from '../../src/core/host-api.js'

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })
const ok = <T>(rpcId: string, value: T) => ({ rpcId, result: { ok: true as const, value } })

async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), 'wechat-session-switch-'))
  cleanups.push(() => rm(dir, { recursive: true, force: true }))
  const file = join(dir, 'bindings.json')
  const bindings = await ConversationBindings.open(file)
  const items = new Map<string, HostSessionSummary>()
  const workspace: HostWorkspace = { workspaceId: 'workspace', path: dir, title: 'WeChat', sessionIds: [] }
  const workspaces = [workspace]
  const api: HostApiProxy = {
    workspace: { list: async request => ok(request.rpcId, { items: workspaces, archivedSessionIds: [] }), create: vi.fn(), rename: vi.fn() },
    presets: { list: vi.fn() },
    sessions: {
      list: vi.fn(async request => ok(request.rpcId, { items: [...items.values()].filter(item => request.payload.sessionIds.includes(item.sessionId)) })),
      create: vi.fn(async request => {
        const owner = workspaces.find(item => item.workspaceId === request.payload.workspaceId) ?? workspace
        owner.sessionIds.push(request.payload.sessionId)
        items.set(request.payload.sessionId, { sessionId: request.payload.sessionId, title: '', running: false })
        return ok(request.rpcId, { sessionId: request.payload.sessionId })
      }),
      history: async request => ok(request.rpcId, { events: [], hasMore: false }),
      prompt: vi.fn(async request => ok(request.rpcId, { accepted: true as const })),
      cancel: vi.fn(), models: vi.fn(), selectModel: vi.fn(),
    },
    events: { async *mux(_request, signal) {
      if (!signal.aborted) await new Promise<void>(resolve => { signal.addEventListener('abort', () => resolve(), { once: true }) })
    } },
    respond: vi.fn(),
  }
  let counter = 0
  const message = (text: string, userId = 'owner'): WeChatInboundMessage => ({ accountId: 'account', userId,
    messageId: `message-${++counter}`, content: [{ type: 'text', text }] })
  const base = message('hello'), key = conversationKeyFor(base), fallback = sessionIdFor(base)
  const sendText = vi.fn(async (_userId: string, _text: string, _contextToken?: string) => undefined)
  const makeRouter = (store: ConversationBindings) => {
    const router = new WeChatConversationRouter(api, { sendText, sendImage: vi.fn(), sendFile: vi.fn(), sendVideo: vi.fn(), typing: vi.fn() },
      { warn: vi.fn(), error: vi.fn() } as never,
      { adminUsers: ['owner'], thinkingText: '', turnTimeoutMs: 300_000, mediaMaxBytes: 1024, sendTyping: false },
      { bindings: store, defaultWorkspace: workspace })
    router.start()
    cleanups.push(() => router.stop())
    return router
  }
  const router = makeRouter(bindings)
  const reply = async (text: string, userId?: string) => {
    sendText.mockClear()
    await router.accept(message(text, userId))
    return String(sendText.mock.calls.at(-1)?.[1] ?? '')
  }
  return { api, bindings, items, workspace, workspaces, file, makeRouter, message, key, fallback, router, reply, sendText }
}

it('lists canonical titles, creates a new session, switches back and restores history after restart', async () => {
  const f = await fixture()
  await f.router.accept(f.message('original task'))
  const first = f.bindings.current(f.key, f.fallback)
  f.items.get(first)!.title = '【微信】修复回传'
  f.items.get(first)!.workspaceTitle = '项目 Alpha'
  expect(await f.reply('/new')).toContain('/session')
  const second = f.bindings.current(f.key, f.fallback)
  expect(second).not.toBe(first)
  f.items.get(second)!.title = '【微信】周末计划'
  f.items.get(second)!.workspaceTitle = '生活'
  const list = await f.reply('/session')
  expect(list).toContain('\n- [2] 周末计划（当前） · 工作区：生活\n- [1] 修复回传 · 工作区：项目 Alpha')
  expect(list).not.toContain('【微信】')
  expect(list).not.toContain('翻页')
  expect(list).not.toContain('\n\n')
  expect(list).toContain('；切换：/session <编号>；新建：/new\n- ')
  expect(f.items.get(first)!.title).toBe('【微信】修复回传')
  expect(await f.reply('/session 1')).toBe('已切换到会话：修复回传（工作区：项目 Alpha）')
  expect(f.bindings.current(f.key, f.fallback)).toBe(first)
  await f.router.accept(f.message('continue the original task'))
  expect(f.api.sessions.prompt).toHaveBeenLastCalledWith(expect.objectContaining({ payload: expect.objectContaining({ sessionId: first }) }))
  expect(f.api.sessions.create).toHaveBeenCalledTimes(2)
  expect(f.api.sessions.cancel).not.toHaveBeenCalled()
  await f.router.stop()
  const restored = await ConversationBindings.open(f.file)
  const router = f.makeRouter(restored)
  f.items.get(second)!.title = '【微信】新的桌面端标题'
  f.items.get(second)!.workspaceTitle = '个人计划'
  f.sendText.mockClear()
  await router.accept(f.message('/session'))
  expect(f.sendText).toHaveBeenLastCalledWith('owner', expect.stringContaining('[1] 修复回传（当前） · 工作区：项目 Alpha'), undefined)
  expect(f.sendText).toHaveBeenLastCalledWith('owner', expect.stringContaining('[2] 新的桌面端标题 · 工作区：个人计划'), undefined)
})

it('keeps other peers private and refuses unknown, archived or deleted session selections', async () => {
  const f = await fixture()
  await f.reply('/new')
  const own = f.bindings.current(f.key, f.fallback)
  const foreign = 'session-wechat-foreign'
  await f.bindings.set('b'.repeat(64), foreign)
  f.items.set(foreign, { sessionId: foreign, title: 'private peer topic', running: true })
  expect(await f.reply('/session')).not.toContain('private peer topic')
  expect(f.api.sessions.list).toHaveBeenLastCalledWith(expect.objectContaining({ payload: { sessionIds: [own] } }))
  for (const selector of [foreign, '999', 'session-wechat-missing']) {
    expect(await f.reply(`/session ${selector}`)).toContain('没有找到')
    expect(f.bindings.current(f.key, f.fallback)).toBe(own)
  }
  f.items.delete(own)
  expect(await f.reply('/session 1')).toContain('没有找到')
  expect(f.bindings.current(f.key, f.fallback)).toBe(own)
  expect(await f.reply('/session', 'guest')).toContain('只有机器人管理员')
})

it('keeps stable numbers across metadata reordering, pagination and title updates', async () => {
  const f = await fixture()
  for (let i = 1; i <= 23; i++) {
    const sessionId = `session-wechat-${i}`
    await f.bindings.set(f.key, sessionId)
    f.items.set(sessionId, { sessionId, title: `topic ${i}`, running: i === 1 })
  }
  expect(await f.reply('/session')).toContain('第 1/2 页')
  f.items.get('session-wechat-23')!.running = true
  expect(await f.reply('/session')).toContain('[23] topic 23（当前 · 执行中） · 工作区：未分组')
  expect(await f.reply('/session')).toContain('翻页：/session list 2')
  expect(await f.reply('/session list 2')).toContain('[1] topic 1（执行中） · 工作区：未分组')
  expect(await f.reply('/session list 3')).toContain('没有这一页')
  expect(await f.reply('/session list 0')).toContain('用法')
  expect(await f.reply('/session 1')).toContain('topic 1')
  expect(f.bindings.current(f.key, f.fallback)).toBe('session-wechat-1')
})

it('bounds multi-line labels without splitting Unicode or altering canonical titles', async () => {
  const f = await fixture()
  await f.reply('/new')
  const current = f.bindings.current(f.key, f.fallback), item = f.items.get(current)!
  item.title = `【微信】  ${'🧭'.repeat(61)}\nextra`
  item.workspaceTitle = 'Project\n\tAlpha'
  const canonical = item.title
  expect(await f.reply('/session')).toContain(`[1] ${'🧭'.repeat(59)}…（当前） · 工作区：Project Alpha`)
  expect(item.title).toBe(canonical)
  item.title = '【微信】  '
  expect(await f.reply('/session')).toContain('[1] 新会话（尚无标题）（当前）')
})

it('lists without creating a model session and preserves the binding when metadata fails', async () => {
  const f = await fixture()
  expect(await f.reply('/session')).toContain('还没有历史会话')
  expect(f.api.sessions.create).not.toHaveBeenCalled()
  expect(f.api.sessions.prompt).not.toHaveBeenCalled()
  expect(await f.reply('/help')).toContain('/session')
  await f.reply('/new')
  const before = f.bindings.current(f.key, f.fallback)
  vi.mocked(f.api.sessions.list).mockRejectedValueOnce(new Error('private host error'))
  expect(await f.reply('/session 1')).toContain('工作台暂时无法完成')
  expect(f.bindings.current(f.key, f.fallback)).toBe(before)
})

it('lists compact workspace names as native bullets, then switches by name without exposing UUIDs', async () => {
  const f = await fixture()
  await f.reply('/new')
  const target: HostWorkspace = { workspaceId: '11111111-1111-4111-8111-111111111111', path: '/fixture/project', title: '项目 Alpha', sessionIds: [] }
  f.workspaces.push(target)
  expect(await f.reply('/workspace')).toBe('当前工作区：WeChat（默认）。可选工作区（/workspace <名称> 切换；/workspace reset 恢复默认）：\n- WeChat（当前 · 默认）\n- 项目 Alpha')
  expect(await f.reply('/workspace')).not.toContain(target.workspaceId)
  expect(await f.reply('/workspace')).not.toContain('\n\n')
  await f.reply('/workspace 项目 Alpha')
  expect(target.sessionIds).toContain(f.bindings.current(f.key, f.fallback))
  expect(await f.reply('/workspace')).toContain('当前工作区：项目 Alpha；默认：WeChat')
  target.title = '项目新名称'
  expect(await f.reply('/workspace')).toContain('- 项目新名称（当前）')
  await f.reply('/workspace reset')
  expect(f.workspace.sessionIds).toContain(f.bindings.current(f.key, f.fallback))
})

it('shows full IDs only for ambiguous workspace labels and still selects the exact requested workspace', async () => {
  const f = await fixture()
  const first: HostWorkspace = { workspaceId: 'first-duplicate', path: '/fixture/first', title: '同名项目', sessionIds: [] }
  const second: HostWorkspace = { workspaceId: 'second-duplicate', path: '/fixture/second', title: '同名项目', sessionIds: [] }
  f.workspaces.push(first, second)
  const reply = await f.reply('/workspace')
  expect(reply).toContain('- 同名项目 · ID：first-duplicate\n- 同名项目 · ID：second-duplicate')
  expect(await f.reply('/workspace 同名项目')).toContain('没有找到')
  await f.reply('/workspace second-duplicate')
  expect(second.sessionIds).toContain(f.bindings.current(f.key, f.fallback))
  expect(first.sessionIds).toEqual([])
})
