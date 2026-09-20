import { describe, expect, it, vi } from 'vitest'
import type { HostApiProxy, HostMuxFrame, RpcRequest } from '../src/host-api.js'
import type { WeChatInboundMessage } from '../src/inbound.js'
import { promptRpcIdFor } from '../src/inbound.js'
import { WeChatConversationRouter } from '../src/router.js'

class MuxBus {
  private frames: RpcRequest<HostMuxFrame>[] = []
  private wake: (() => void) | undefined

  push(frame: RpcRequest<HostMuxFrame>): void {
    this.frames.push(frame)
    this.wake?.()
    this.wake = undefined
  }

  async *stream(signal: AbortSignal): AsyncIterable<RpcRequest<HostMuxFrame>> {
    while (!signal.aborted) {
      const frame = this.frames.shift()
      if (frame !== undefined) {
        yield frame
        continue
      }
      await new Promise<void>(resolve => {
        this.wake = resolve
        signal.addEventListener('abort', () => { resolve() }, { once: true })
      })
    }
  }
}

function ok<T>(rpcId: string, value: T) {
  return { rpcId, result: { ok: true as const, value } }
}

function inbound(text: string, messageId = 'message-a'): WeChatInboundMessage {
  return {
    accountId: 'account-a', messageId, userId: 'peer-a', contextToken: 'context-a',
    content: [{ type: 'text', text }],
  }
}

function hostFixture(disposition: 'next-turn' | 'next-step', historyEvents: Array<{ event: {
  type: string; seq: number; data: unknown
} }> = [], assistantContent: unknown[] = [{ type: 'text', text: '最终回复' }]) {
  const bus = new MuxBus()
  const prompt = vi.fn(async (request: Parameters<HostApiProxy['sessions']['prompt']>[0]) => {
    if (disposition === 'next-turn') {
      queueMicrotask(() => {
        const events = [
          { type: 'agent/inbox/spliced', seq: 0, data: { inserted: [{ source: { rpcId: request.rpcId } }] } },
          { type: 'turn/start', seq: 1, data: { turn: 1 } },
          { type: 'step/start', seq: 3, data: { turn: 1 } },
          { type: 'assistant/message', seq: 4, data: { turn: 1, message: { content: assistantContent } } },
          { type: 'turn/end', seq: 5, data: { turn: 1, reason: { kind: 'completed' } } },
        ]
        for (const event of events) bus.push({ rpcId: `event-${event.seq}`, payload: {
          type: 'session/event', sessionId: request.payload.sessionId, event,
        } })
      })
    }
    return ok(request.rpcId, { accepted: true as const, disposition })
  })
  const api = {
    workspace: {
      list: async (request: { rpcId: string }) => ok(request.rpcId, { items: [], archivedSessionIds: [] }),
      create: async (request: { rpcId: string }) => ok(request.rpcId, { workspace: {}, created: false }),
      rename: async (request: { rpcId: string }) => ok(request.rpcId, { workspace: {} }),
    },
    sessions: {
      create: async (request: { rpcId: string; payload: { sessionId: string; agentPreset?: string } }) => ok(request.rpcId, request.payload),
      history: async (request: { rpcId: string }) => ok(request.rpcId, { events: historyEvents, hasMore: false }),
      prompt,
      models: async (request: { rpcId: string }) => ok(request.rpcId, { current: { provider: 'p', model: 'm' }, groups: [] }),
      selectModel: async (request: { rpcId: string }) => ok(request.rpcId, { selected: { provider: 'p', model: 'm' } }),
    },
    events: { mux: (_request: unknown, signal: AbortSignal) => bus.stream(signal) },
    respond: async () => ({ accepted: true as const }),
  } as unknown as HostApiProxy
  return { api, prompt }
}

function routerFixture(
  api: HostApiProxy,
  runtime?: ConstructorParameters<typeof WeChatConversationRouter>[4],
  writeSettings?: ConstructorParameters<typeof WeChatConversationRouter>[5],
  config: { agentPreset?: string } = {},
) {
  const sendText = vi.fn(async () => undefined)
  const sendImage = vi.fn(async (_userId: string, _bytes: Buffer, _token?: string) => undefined)
  const typing = vi.fn(async () => undefined)
  const router = new WeChatConversationRouter(
    api,
    { sendText, sendImage, typing },
    { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), success: vi.fn() } as never,
    { adminUsers: ['peer-a'], thinkingText: '正在思考…', turnTimeoutMs: 5_000,
      mediaMaxBytes: 1024, sendTyping: true, ...config },
    runtime ?? { bindings: { current: (_key, fallback) => fallback, set: async () => undefined },
      defaultWorkspace: { workspaceId: 'workspace-a', path: '/tmp/workspace', title: 'WeChat', sessionIds: [] },
      readImage: async (ref: { attachmentId: string }) =>
        new Uint8Array(Buffer.from(`bytes-of-${ref.attachmentId}`)) },
    writeSettings,
  )
  router.start()
  return { router, sendText, sendImage, typing }
}

describe('WeChatConversationRouter', () => {
  it('keeps routing in the selected Workspace after the switch command', async () => {
    const { api, prompt } = hostFixture('next-turn')
    const workspaces = [
      { workspaceId: 'workspace-a', path: '/a', title: 'WeChat', sessionIds: [] as string[] },
      { workspaceId: 'workspace-b', path: '/b', title: '项目 Alpha', sessionIds: [] as string[] },
    ]
    api.workspace.list = async request => ok(request.rpcId, { items: workspaces, archivedSessionIds: [] })
    api.sessions.create = vi.fn(async request => {
      const owner = workspaces.find(workspace => workspace.sessionIds.includes(request.payload.sessionId))
      if (owner !== undefined && owner.workspaceId !== request.payload.workspaceId) {
        return { rpcId: request.rpcId, result: { ok: false as const,
          error: { code: 'session-conflict', message: 'wrong workspace' } } }
      }
      workspaces.find(workspace => workspace.workspaceId === request.payload.workspaceId)
        ?.sessionIds.push(request.payload.sessionId)
      return ok(request.rpcId, request.payload)
    }) as never
    let boundSession: string | undefined
    const { router, sendText } = routerFixture(api, {
      bindings: {
        current: (_key, fallback) => boundSession ?? fallback,
        set: async (_key, sessionId) => { boundSession = sessionId },
      },
      defaultWorkspace: workspaces[0]!,
    })

    router.accept(inbound('/workspace 项目 Alpha'))
    await vi.waitFor(() => { expect(sendText).toHaveBeenCalledWith(
      'peer-a', expect.stringContaining('已切换到工作区“项目 Alpha”'), 'context-a',
    ) })
    const switchedSession = boundSession
    router.accept(inbound('继续处理项目', 'message-after-switch'))

    await vi.waitFor(() => { expect(prompt).toHaveBeenCalledWith(expect.objectContaining({
      payload: expect.objectContaining({ sessionId: switchedSession }),
    })) })
    expect(workspaces[1]!.sessionIds).toContain(switchedSession)
    await router.stop()
  })

  it('lets the active WeChat user resolve a text approval without a model turn', async () => {
    const fixture = hostFixture('next-turn')
    fixture.api.sessions.prompt = vi.fn(async request => ok(request.rpcId, {
      accepted: true as const, disposition: 'next-turn' as const,
    }))
    const { router, sendText } = routerFixture(fixture.api)
    router.accept(inbound('执行需要审批的操作'))
    await vi.waitFor(() => { expect(fixture.api.sessions.prompt).toHaveBeenCalledOnce() })
    const sessionId = vi.mocked(fixture.api.sessions.prompt).mock.calls[0]![0].payload.sessionId
    await vi.waitFor(() => { expect(router.ownsSession(sessionId)).toBe(true) })
    let publishResolution: ((value: { outcome: 'allowed-once' }) => void) | undefined
    const resolved = new Promise<{ outcome: 'allowed-once' }>(resolve => { publishResolution = resolve })
    const approval = router.requestApproval({ id: 'approval-a', sessionId, toolName: 'bash', resolved })
    await vi.waitFor(() => { expect(sendText).toHaveBeenCalledWith(
      'peer-a', expect.stringContaining('需要你的审批'), 'context-a',
    ) })

    router.accept(inbound('/approve', 'approval-answer'))
    await expect(approval).resolves.toMatchObject({ outcome: 'allowed-once' })
    expect(fixture.api.sessions.prompt).toHaveBeenCalledOnce()
    publishResolution?.({ outcome: 'allowed-once' })
    await router.stop()
  })

  it('handles administrator help commands without sending them to the model', async () => {
    const { api, prompt } = hostFixture('next-turn')
    const { router, sendText } = routerFixture(api)

    router.accept(inbound('/help'))

    await vi.waitFor(() => {
      expect(sendText).toHaveBeenCalledWith(
        'peer-a', expect.stringContaining('/workspace'), 'context-a',
      )
    })
    expect(prompt).not.toHaveBeenCalled()
    await router.stop()
  })

  it('observes the admitted durable turn and sends its final assistant text', async () => {
    const { api, prompt } = hostFixture('next-turn')
    const { router, sendText, typing } = routerFixture(api)

    router.accept(inbound('你好'))

    await vi.waitFor(() => { expect(sendText).toHaveBeenCalledWith('peer-a', '最终回复', 'context-a') })
    expect(prompt).toHaveBeenCalledOnce()
    expect(typing).toHaveBeenCalledWith('peer-a', 1, 'context-a')
    expect(typing).toHaveBeenCalledWith('peer-a', 2, 'context-a')
    await router.stop()
  })

  it.each([
    {
      name: 'alongside text',
      content: [
        { type: 'text', text: '图片说明' },
        { type: 'image', attachment: { attachmentId: 'image-a', mediaType: 'image/png' } },
      ],
      finalText: '图片说明',
      attachments: ['image-a'],
    },
    {
      name: 'without text',
      content: [
        { type: 'image', attachment: { attachmentId: 'image-a', mediaType: 'image/png' } },
        { type: 'image', attachment: { attachmentId: 'image-b', mediaType: 'image/png' } },
      ],
      finalText: '图片如下：',
      attachments: ['image-a', 'image-b'],
    },
  ])('sends durable image attachments $name', async ({ content, finalText, attachments }) => {
    const { api } = hostFixture('next-turn', [], content)
    const { router, sendText, sendImage } = routerFixture(api)

    router.accept(inbound('生成图片'))

    await vi.waitFor(() => { expect(sendImage).toHaveBeenCalledTimes(attachments.length) })
    expect(sendText).toHaveBeenCalledWith('peer-a', finalText, 'context-a')
    expect(sendImage.mock.calls.map(call => call[1].toString()))
      .toEqual(attachments.map(id => `bytes-of-${id}`))
    expect(sendText).not.toHaveBeenCalledWith('peer-a', '本轮没有文本回复。', 'context-a')
    await router.stop()
  })

  it('names the images it could not deliver rather than dropping them silently', async () => {
    const { api } = hostFixture('next-turn', [], [
      { type: 'image', attachment: { attachmentId: 'image-a', mediaType: 'image/png' } },
    ])
    const { router, sendText, sendImage } = routerFixture(api)
    sendImage.mockRejectedValue(new Error('wechat: media upload returned HTTP 500'))

    router.accept(inbound('生成图片'))

    await vi.waitFor(() => {
      expect(sendText).toHaveBeenCalledWith(
        'peer-a', '本轮生成的 1 张图片未能发送到微信，已保存在 DSH 会话中。', 'context-a')
    })
    await router.stop()
  })

  it('queues a message when the channel does not own an active turn', async () => {
    const { api, prompt } = hostFixture('next-turn')
    const { router, sendText } = routerFixture(api)
    router.accept(inbound('补充要求'))
    await vi.waitFor(() => { expect(prompt).toHaveBeenCalledOnce() })
    expect(prompt.mock.calls[0]?.[0].payload.mode).toBe('queue')
    expect(sendText).not.toHaveBeenCalledWith('peer-a', '已加入当前任务。', 'context-a')
    await router.stop()
  })

  it('admits steering while the original channel-owned turn is still running', async () => {
    const bus = new MuxBus()
    let promptCount = 0
    const base = hostFixture('next-step')
    base.api.sessions.prompt = vi.fn(async request => {
      promptCount += 1
      return ok(request.rpcId, { accepted: true as const,
        disposition: promptCount === 1 ? 'next-turn' as const : 'next-step' as const })
    })
    base.api.events.mux = (_request, signal) => bus.stream(signal)
    const { router, sendText } = routerFixture(base.api)

    router.accept(inbound('先执行长任务', 'message-first'))
    await vi.waitFor(() => { expect(promptCount).toBe(1) })
    router.accept(inbound('补充条件', 'message-second'))

    await vi.waitFor(() => { expect(promptCount).toBe(2) })
    expect(sendText).toHaveBeenCalledWith('peer-a', '已加入当前任务。', 'context-a')
    await router.stop()
  })

  it('does not submit a callback whose durable prompt identity is already recorded', async () => {
    const duplicate = inbound('重复消息')
    const rpcId = promptRpcIdFor(duplicate)
    const { api, prompt } = hostFixture('next-turn', [{ event: {
      type: 'agent/inbox/spliced', seq: 7, data: { inserted: [{ source: { rpcId } }] },
    } }])
    const { router, sendText } = routerFixture(api)

    router.accept(duplicate)

    await new Promise(resolve => setTimeout(resolve, 20))
    expect(prompt).not.toHaveBeenCalled()
    expect(sendText).not.toHaveBeenCalled()
    await router.stop()
  })

  it('pins a channel preset, rebuilds the session, and states the model command reach', async () => {
    const { api } = hostFixture('next-turn')
    const workspaces = [
      { workspaceId: 'workspace-a', path: '/a', title: 'WeChat', sessionIds: [] as string[] },
    ]
    api.workspace.list = async request => ok(request.rpcId, { items: workspaces, archivedSessionIds: [] })
    api.sessions.create = vi.fn(async request => {
      workspaces[0]!.sessionIds.push(request.payload.sessionId)
      return ok(request.rpcId, request.payload)
    }) as never
    api.presets = {
      list: async request => ok(request.rpcId, {
        items: [
          { id: 'standard', name: '标准' },
          { id: 'half-authored', broken: '缺少 agent.cordis.yml' },
        ],
        defaultId: 'standard',
      }),
    }
    api.sessions.models = async request => ok(request.rpcId, {
      current: { provider: 'deepseek', model: 'deepseek-chat', reasoningEffort: 'high' },
      groups: [{
        id: 'deepseek', name: 'DeepSeek', models: [{
          id: 'deepseek-chat', name: 'DeepSeek Chat',
          reasoning: { efforts: [{ id: 'off', name: 'Off' }, { id: 'high', name: 'High' }] },
        }],
      }],
    })
    api.sessions.selectModel = vi.fn(async request => ok(request.rpcId, {
      selected: { provider: request.payload.provider, model: request.payload.model, reasoningEffort: request.payload.reasoningEffort },
    })) as never
    const writeSettings = vi.fn(async () => undefined)
    let boundSession: string | undefined
    const { router, sendText } = routerFixture(api, {
      bindings: {
        current: (_key, fallback) => boundSession ?? fallback,
        set: async (_key, sessionId) => { boundSession = sessionId },
      },
      defaultWorkspace: workspaces[0]!,
    }, writeSettings)

    router.accept(inbound('/preset'))
    await vi.waitFor(() => { expect(sendText).toHaveBeenCalledWith(
      'peer-a', expect.stringContaining('跟随全局默认（standard）'), 'context-a',
    ) })

    router.accept(inbound('/preset nope', 'message-unknown'))
    await vi.waitFor(() => { expect(sendText).toHaveBeenCalledWith(
      'peer-a', expect.stringContaining('没有找到预设“nope”'), 'context-a',
    ) })

    router.accept(inbound('/preset half-authored', 'message-broken'))
    await vi.waitFor(() => { expect(sendText).toHaveBeenCalledWith(
      'peer-a', expect.stringContaining('当前不可用'), 'context-a',
    ) })
    expect(writeSettings).not.toHaveBeenCalled()

    router.accept(inbound('/preset standard', 'message-preset'))
    await vi.waitFor(() => { expect(sendText).toHaveBeenCalledWith(
      'peer-a', expect.stringContaining('已切换到预设“standard”'), 'context-a',
    ) })
    expect(writeSettings).toHaveBeenCalledWith({ agentPreset: 'standard' })
    expect(api.sessions.create).toHaveBeenCalledWith(expect.objectContaining({
      payload: expect.objectContaining({ sessionId: boundSession, agentPreset: 'standard' }),
    }))

    router.accept(inbound('/model deepseek deepseek-chat high', 'message-model'))
    await vi.waitFor(() => { expect(sendText).toHaveBeenCalledWith(
      'peer-a', expect.stringContaining('全局默认模型'), 'context-a',
    ) })
    await router.stop()
  })

  it('clears the pinned preset without claiming a rejected write succeeded', async () => {
    const { api } = hostFixture('next-turn')
    api.presets = { list: async request => ok(request.rpcId, { items: [], defaultId: 'standard' }) }
    const writeSettings = vi.fn(async () => { throw new Error('settings provider is read-only') })
    const { router, sendText } = routerFixture(api, undefined, writeSettings, { agentPreset: 'standard' })
    router.accept(inbound('/preset reset'))

    await vi.waitFor(() => { expect(sendText).toHaveBeenCalledWith(
      'peer-a', expect.stringContaining('预设未能保存'), 'context-a',
    ) })
    expect(sendText).toHaveBeenCalledWith(
      'peer-a', expect.stringContaining('settings provider is read-only'), 'context-a',
    )
    await router.stop()
  })
})


it('accepts a new peer without an ID allowlist but does not grant management commands', async () => {
  const { api, prompt } = hostFixture('next-turn'), { router, sendText } = routerFixture(api)
  try {
    await router.accept({ ...inbound('hello', 'guest-chat'), userId: 'guest' })
    expect(prompt).toHaveBeenCalledOnce()
    await router.accept({ ...inbound('/workspace private', 'guest-command'), userId: 'guest' })
    expect(prompt).toHaveBeenCalledOnce()
    expect(sendText).toHaveBeenCalledWith('guest', expect.stringContaining('只有机器人管理员'), 'context-a')
  } finally { await router.stop() }
})

it('leaves guest tool approvals with the Host instead of granting them through WeChat', async () => {
  const { api } = hostFixture('next-turn')
  api.sessions.prompt = vi.fn(async request => ok(request.rpcId, { accepted: true as const, disposition: 'next-turn' as const }))
  const { router } = routerFixture(api)
  const running = router.accept({ ...inbound('a request', 'guest-approval'), userId: 'guest' })
  try {
    await vi.waitFor(() => expect(api.sessions.prompt).toHaveBeenCalledOnce())
    const sessionId = vi.mocked(api.sessions.prompt).mock.calls[0]![0].payload.sessionId
    expect(router.ownsSession(sessionId)).toBe(false)
    expect(await router.requestApproval({ id: 'guest-request', sessionId, toolName: 'bash', resolved: new Promise(() => {}) })).toBeUndefined()
  } finally { await router.stop(); await running }
})
