import type { Logger } from '@deepseek-ai/cordis'
import type { ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import { EventType, MessageType } from '@wecom/aibot-node-sdk'
import type { TemplateCard, WsFrame } from '@wecom/aibot-node-sdk'
import { describe, expect, it, vi } from 'vitest'
import type {
  HostApiProxy,
  HostMuxFrame,
  RpcRequest,
  RpcResponse,
} from '../src/host-api.js'
import { normalizeTextFrame, promptRpcIdFor } from '../src/inbound.js'
import type { WeComTextFrame } from '../src/inbound.js'
import { WeComConversationRouter } from '../src/router.js'
import type { WeComReplyClient, WeComTemplateCardEventFrame } from '../src/router.js'

function success<T>(request: RpcRequest<unknown>, value: T): RpcResponse<T> {
  return { rpcId: request.rpcId, result: { ok: true, value } }
}

class AsyncFrameQueue {
  private readonly values: RpcRequest<HostMuxFrame>[] = []
  private readonly waiters: Array<(value: RpcRequest<HostMuxFrame> | undefined) => void> = []

  push(value: RpcRequest<HostMuxFrame>): void {
    const waiter = this.waiters.shift()
    if (waiter === undefined) this.values.push(value)
    else waiter(value)
  }

  async next(signal: AbortSignal): Promise<RpcRequest<HostMuxFrame> | undefined> {
    const value = this.values.shift()
    if (value !== undefined) return value
    if (signal.aborted) return undefined
    return new Promise((resolve) => {
      const settle = (frame: RpcRequest<HostMuxFrame> | undefined): void => {
        signal.removeEventListener('abort', onAbort)
        resolve(frame)
      }
      const onAbort = (): void => {
        const index = this.waiters.indexOf(settle)
        if (index >= 0) this.waiters.splice(index, 1)
        settle(undefined)
      }
      this.waiters.push(settle)
      signal.addEventListener('abort', onAbort, { once: true })
    })
  }
}

function logger(): Logger {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    success: vi.fn(),
  } as unknown as Logger
}

function textFrame(
  content = '你好',
  userId = 'user-1',
  chatType: 'single' | 'group' = 'single',
  messageId = 'message-1',
  requestId = 'wecom-request',
): WeComTextFrame {
  return {
    headers: { req_id: requestId },
    body: {
      msgid: messageId,
      aibotid: 'bot-1',
      chattype: chatType,
      ...(chatType === 'group' ? { chatid: 'group-1' } : {}),
      from: { userid: userId },
      msgtype: MessageType.Text,
      text: { content },
    },
  }
}

function event(sessionId: string, seq: number, type: string, data: unknown): RpcRequest<HostMuxFrame> {
  return {
    rpcId: `event-${seq}`,
    payload: { type: 'session/event', sessionId, event: { type, seq, data } },
  }
}

function cardEvent(
  taskId: string,
  eventKey: string,
  userId = 'user-1',
): WeComTemplateCardEventFrame {
  // The installed SDK types flatten these fields, while live WeCom callbacks nest them.
  return {
    headers: { req_id: `card-event-${eventKey}` },
    body: {
      msgid: `card-message-${eventKey}`,
      create_time: 1,
      aibotid: 'bot-1',
      chatid: 'group-1',
      chattype: 'group',
      from: { userid: userId },
      msgtype: 'event',
      event: {
        eventtype: EventType.TemplateCardEvent,
        template_card_event: {
          card_type: 'button_interaction',
          event_key: eventKey,
          task_id: taskId,
        },
      },
    },
  } as unknown as WeComTemplateCardEventFrame
}

function harness(
  historyEvents: Array<{ event: { type: string; seq: number; data: unknown } }> = [],
  assistantContent: unknown[] = [{ type: 'text', text: '你好，世界' }],
): {
  api: HostApiProxy
  create: ReturnType<typeof vi.fn>
  history: ReturnType<typeof vi.fn>
  prompt: ReturnType<typeof vi.fn>
  models: ReturnType<typeof vi.fn>
  selectModel: ReturnType<typeof vi.fn>
  respond: ReturnType<typeof vi.fn>
  listPresets: HostApiProxy['presets']['list'] & ReturnType<typeof vi.fn>
  pushMux(frame: RpcRequest<HostMuxFrame>): void
  replies: WeComReplyClient
  replyCalls: Array<{ content: string; finish: boolean }>
  reliableCalls: Array<{ content: string; finish: boolean }>
  streamCalls: Array<{
    reqId: string
    streamId: string
    content: string
    finish: boolean
    reliable: boolean
  }>
  sentCards: Array<{ targetId: string; card: TemplateCard }>
  proactiveTexts: Array<{ targetId: string; content: string }>
  updatedCards: TemplateCard[]
  uploads: Array<{ bytes: Buffer; filename: string }>
  sentMedia: Array<{ targetId: string; mediaType: string; mediaId: string }>
  readImage: (ref: ImageAttachmentRef) => Promise<Uint8Array>
  failUploads(error: Error): void
} {
  const queue = new AsyncFrameQueue()
  const replyCalls: Array<{ content: string; finish: boolean }> = []
  const reliableCalls: Array<{ content: string; finish: boolean }> = []
  const streamCalls: Array<{
    reqId: string; streamId: string; content: string; finish: boolean; reliable: boolean
  }> = []
  const sentCards: Array<{ targetId: string; card: TemplateCard }> = []
  const proactiveTexts: Array<{ targetId: string; content: string }> = []
  const updatedCards: TemplateCard[] = []
  const uploads: Array<{ bytes: Buffer; filename: string }> = []
  const sentMedia: Array<{ targetId: string; mediaType: string; mediaId: string }> = []
  let uploadFailure: Error | undefined
  const readImage = vi.fn(async (ref: { attachmentId: string }) =>
    new Uint8Array(Buffer.from(`bytes-of-${ref.attachmentId}`)))
  const prompt = vi.fn(async (request: RpcRequest<{
    sessionId: string
    mode: 'queue' | 'steer'
    content: [{ type: 'text'; text: string }]
  }>) => {
    const { sessionId } = request.payload
    queue.push(event(sessionId, 0, 'agent/inbox/spliced', {
      inserted: [{ source: { kind: 'user', rpcId: request.rpcId } }],
    }))
    queue.push(event(sessionId, 1, 'turn/start', { turn: 1 }))
    queue.push(event(sessionId, 2, 'step/start', { turn: 1, step: 1 }))
    const streamedPrefix = assistantContent
      .map((block) => {
        const item = block as { type?: string; text?: string }
        return item.type === 'text' ? item.text ?? '' : ''
      })
      .join('')
      .slice(0, 2)
    if (streamedPrefix !== '') {
      queue.push(event(sessionId, 3, 'assistant/chunk', {
        turn: 1,
        step: 1,
        chunk: { type: 'text-delta', index: 0, text: streamedPrefix },
      }))
    }
    queue.push(event(sessionId, 4, 'assistant/message', {
      turn: 1,
      step: 1,
      message: { content: assistantContent },
    }))
    queue.push(event(sessionId, 5, 'turn/end', { turn: 1, reason: { kind: 'completed' } }))
    return success(request, { accepted: true as const, disposition: 'next-turn' as const })
  })
  const history = vi.fn(async (request: RpcRequest<{
    sessionId: string
    beforeSeq?: number
    maxMessages?: number
  }>) => success(request, { events: historyEvents, hasMore: false }))
  const workspaces = [{
    workspaceId: 'workspace-wecom',
    title: '企业微信机器人',
    path: '/workspaces/wecom',
    sessionIds: [] as string[],
  }, {
    workspaceId: 'workspace-project',
    title: '项目 Alpha',
    path: '/workspaces/project-alpha',
    sessionIds: [] as string[],
  }]
  const listWorkspaces = vi.fn(async (request: RpcRequest<Record<string, never>>) => success(request, {
    items: workspaces.map(workspace => ({ ...workspace, sessionIds: [...workspace.sessionIds] })),
    archivedSessionIds: [],
  }))
  const create = vi.fn(async (request: RpcRequest<{
    sessionId: string
    workspaceId?: string
    agentPreset?: string
  }>) => {
    const workspace = workspaces.find(entry => entry.workspaceId === request.payload.workspaceId)
    if (workspace !== undefined && !workspace.sessionIds.includes(request.payload.sessionId)) {
      workspace.sessionIds.push(request.payload.sessionId)
    }
    return success(request, { sessionId: request.payload.sessionId })
  })
  const models = vi.fn(async (request: RpcRequest<{ sessionId: string }>) => success(request, {
    current: { provider: 'deepseek', model: 'deepseek-chat', reasoningEffort: 'high' },
    groups: [{
      id: 'deepseek', name: 'DeepSeek', models: [{
        id: 'deepseek-chat', name: 'DeepSeek Chat',
        reasoning: { efforts: [{ id: 'off', name: 'Off' }, { id: 'high', name: 'High' }], defaultEffort: 'high' },
      }],
    }],
  }))
  const selectModel = vi.fn(async (request: RpcRequest<{
    sessionId: string; provider: string; model: string; reasoningEffort?: string
  }>) => success(request, { selected: {
    provider: request.payload.provider,
    model: request.payload.model,
    ...request.payload.reasoningEffort === undefined ? {} : { reasoningEffort: request.payload.reasoningEffort },
  } }))
  const respond = vi.fn(async () => ({ accepted: true as const }))
  const listPresets = vi.fn(async (request: RpcRequest<Record<string, never>>) => success(request, {
    items: [
      { id: 'standard', name: '标准' },
      { id: 'dsh-security-audit', name: '安全审计' },
      { id: 'half-authored', broken: '缺少 agent.cordis.yml' },
    ],
    defaultId: 'standard',
  }))
  const api: HostApiProxy = {
    workspace: {
      list: listWorkspaces,
      create: vi.fn(),
      rename: vi.fn(),
    },
    presets: { list: listPresets },
    sessions: {
      create,
      history,
      prompt,
      models,
      selectModel,
    },
    events: {
      async *mux(_request, signal) {
        while (!signal.aborted) {
          const frame = await queue.next(signal)
          if (frame === undefined) return
          yield frame
        }
      },
    },
    respond,
  }
  const replies: WeComReplyClient & {
    sendMessage(
      targetId: string,
      body: { msgtype: 'template_card'; template_card: TemplateCard }
        | { msgtype: 'markdown'; markdown: { content: string } },
    ): Promise<WsFrame>
  } = {
    async replyStream(frame, streamId, content, finish = false) {
      replyCalls.push({ content, finish })
      reliableCalls.push({ content, finish })
      streamCalls.push({ reqId: frame.headers.req_id, streamId, content, finish, reliable: true })
      return {} as WsFrame
    },
    async replyStreamNonBlocking(frame, streamId, content, finish = false) {
      replyCalls.push({ content, finish })
      streamCalls.push({ reqId: frame.headers.req_id, streamId, content, finish, reliable: false })
      return {} as WsFrame
    },
    async updateTemplateCard(_frame, templateCard) {
      updatedCards.push(templateCard)
      return {} as WsFrame
    },
    async sendMessage(targetId, body) {
      if (body.msgtype === 'template_card') sentCards.push({ targetId, card: body.template_card })
      else proactiveTexts.push({ targetId, content: body.markdown.content })
      return {} as WsFrame
    },
    async uploadMedia(fileBuffer, options) {
      uploads.push({ bytes: Buffer.from(fileBuffer), filename: options.filename })
      if (uploadFailure !== undefined) throw uploadFailure
      return { media_id: `media-${uploads.length}` }
    },
    async sendMediaMessage(targetId, mediaType, mediaId) {
      sentMedia.push({ targetId, mediaType, mediaId })
      return {} as WsFrame
    },
  }
  return {
    api, create, history, prompt, models, selectModel, respond, listPresets,
    pushMux: frame => { queue.push(frame) },
    replies, replyCalls, reliableCalls, streamCalls, sentCards, proactiveTexts, updatedCards,
    uploads, sentMedia, readImage,
    failUploads: (error: Error) => { uploadFailure = error },
  }
}

describe('WeComConversationRouter', () => {
  const defaultWorkspace = () => ({
    workspaceId: 'workspace-wecom',
    title: '企业微信机器人',
    path: '/workspaces/wecom',
    sessionIds: [],
  })
  const runtime = (test?: ReturnType<typeof harness>) => ({
    defaultWorkspace: defaultWorkspace(),
    bindings: {
      current: (_key: string, fallback: string) => fallback,
      set: vi.fn(async () => undefined),
    },
    ...test === undefined ? {} : { readImage: test.readImage },
  })

  it('projects one admitted Host turn as incremental and final WeCom replies', async () => {
    const test = harness()
    const router = new WeComConversationRouter(test.api, test.replies, logger(), {
      allowedUsers: [],
      adminUsers: [],
      thinkingText: '处理中',
      turnTimeoutMs: 1_000,
    }, runtime())
    router.start()
    router.accept(textFrame())

    await vi.waitFor(() => {
      expect(test.replyCalls.at(-1)).toEqual({ content: '你好，世界', finish: true })
    })
    expect(test.replyCalls).toContainEqual({ content: '处理中', finish: false })
    expect(test.replyCalls).toContainEqual({ content: '你好', finish: false })
    expect(test.reliableCalls).toContainEqual({ content: '你好，世界', finish: true })
    expect(test.prompt).toHaveBeenCalledTimes(1)

    await router.stop()
  })

  it('observes the session from the moment the turn subscribes, not when the prompt returns', async () => {
    const test = harness()
    let release!: () => void
    const held = new Promise<void>((resolve) => { release = resolve })
    let promptedSession: string | undefined
    const submit = test.api.sessions.prompt
    test.api.sessions.prompt = (async (request: Parameters<typeof submit>[0]) => {
      promptedSession = request.payload.sessionId
      await held
      return await submit(request)
    }) as typeof submit
    const router = new WeComConversationRouter(test.api, test.replies, logger(), {
      allowedUsers: [],
      adminUsers: [],
      thinkingText: '处理中',
      turnTimeoutMs: 1_000,
    }, runtime())
    router.start()
    router.accept(textFrame())

    await vi.waitFor(() => { expect(promptedSession).toBeDefined() })
    // The turn is not active yet, but its events are already being emitted, so the
    // channel has to be observing the session or it loses the events that claim it.
    expect(router.observesSession(promptedSession!)).toBe(true)
    expect(router.routesSession(promptedSession!)).toBe(false)

    release()
    await vi.waitFor(() => {
      expect(test.replyCalls.at(-1)).toEqual({ content: '你好，世界', finish: true })
    })

    await router.stop()
  })

  it.each([
    {
      name: 'alongside text',
      content: [
        { type: 'text', text: '这是配图说明' },
        { type: 'image', attachment: { attachmentId: 'image-a', mediaType: 'image/png' } },
      ],
      finalText: '这是配图说明',
      filenames: ['image-1.png'],
    },
    {
      name: 'without text',
      content: [
        { type: 'image', attachment: { attachmentId: 'image-a', mediaType: 'image/png', name: '图表' } },
        { type: 'image', attachment: { attachmentId: 'image-b', mediaType: 'image/jpeg' } },
      ],
      finalText: '图片如下：',
      filenames: ['图表.png', 'image-2.jpg'],
    },
  ])('uploads and sends durable image attachments $name', async ({ content, finalText, filenames }) => {
    const test = harness([], content)
    const router = new WeComConversationRouter(test.api, test.replies, logger(), {
      allowedUsers: [],
      adminUsers: [],
      thinkingText: '处理中',
      turnTimeoutMs: 1_000,
    }, runtime(test))
    router.start()
    router.accept(textFrame())

    await vi.waitFor(() => {
      expect(test.sentMedia).toHaveLength(filenames.length)
    })
    expect(test.replyCalls.at(-1)).toEqual({ content: finalText, finish: true })
    expect(test.uploads.map(upload => upload.filename)).toEqual(filenames)
    expect(test.uploads.map(upload => upload.bytes.toString())).toEqual(
      content.filter(block => block.type === 'image')
        .map(block => `bytes-of-${(block as { attachment: { attachmentId: string } }).attachment.attachmentId}`))
    expect(test.sentMedia.map(sent => sent.mediaType)).toEqual(filenames.map(() => 'image'))
    expect(test.replyCalls).not.toContainEqual({ content: '本轮没有文本回复。', finish: true })

    await router.stop()
  })

  it('names the images it could not deliver rather than dropping them silently', async () => {
    const test = harness([], [
      { type: 'text', text: '这是配图说明' },
      { type: 'image', attachment: { attachmentId: 'image-a', mediaType: 'image/png' } },
    ])
    test.failUploads(new Error('wecom: media upload rejected'))
    const router = new WeComConversationRouter(test.api, test.replies, logger(), {
      allowedUsers: [],
      adminUsers: [],
      thinkingText: '处理中',
      turnTimeoutMs: 1_000,
    }, runtime(test))
    router.start()
    router.accept(textFrame())

    await vi.waitFor(() => {
      expect(test.proactiveTexts.at(-1)?.content)
        .toBe('本轮生成的 1 张图片未能发送到企微，已保存在 DSH 会话中。')
    })
    expect(test.sentMedia).toHaveLength(0)
    expect(test.replyCalls).toContainEqual({ content: '这是配图说明', finish: true })

    await router.stop()
  })

  it('does not start or reply to a message already admitted before restart', async () => {
    const frame = textFrame()
    const promptRpcId = promptRpcIdFor(normalizeTextFrame(frame))
    const test = harness([{
      event: {
        type: 'agent/inbox/spliced',
        seq: 8,
        data: { inserted: [{ source: { kind: 'user', rpcId: promptRpcId } }] },
      },
    }])
    const router = new WeComConversationRouter(test.api, test.replies, logger(), {
      allowedUsers: [],
      adminUsers: [],
      thinkingText: '处理中',
      turnTimeoutMs: 1_000,
    }, runtime())
    router.start()
    router.accept(frame)

    await vi.waitFor(() => expect(test.history).toHaveBeenCalledTimes(1))
    expect(test.prompt).not.toHaveBeenCalled()
    expect(test.replyCalls).toEqual([])

    await router.stop()
  })

  it.each([
    ['session-conflict', 'existing cwd differs'],
    ['agent-preset-conflict', 'existing preset differs'],
  ] as const)('moves an incompatible conversation after %s', async (errorCode, message) => {
    const test = harness()
    test.create.mockImplementationOnce(async (request: RpcRequest<{
      sessionId: string; workspaceId?: string; agentPreset?: string
    }>) => ({
      rpcId: request.rpcId,
      result: { ok: false, error: { code: errorCode, message } },
    }))
    const set = vi.fn(async (_conversationKey: string, _sessionId: string) => undefined)
    const router = new WeComConversationRouter(test.api, test.replies, logger(), {
      allowedUsers: [], adminUsers: [], agentPreset: 'aidev', thinkingText: '处理中', turnTimeoutMs: 1_000,
    }, {
      defaultWorkspace: defaultWorkspace(),
      bindings: { current: (_key, fallback) => fallback, set },
    })
    router.start()
    router.accept(textFrame())

    await vi.waitFor(() => expect(test.replyCalls.at(-1)).toEqual({ content: '你好，世界', finish: true }))
    expect(set).toHaveBeenCalledOnce()
    const replacement = set.mock.calls[0]?.[1]
    expect(replacement).toMatch(/^session-wecom-[a-f0-9]{32}$/)
    expect(test.prompt.mock.calls[0]?.[0].payload.sessionId).toBe(replacement)
    expect(test.create).toHaveBeenCalledTimes(2)
    expect(test.create.mock.calls[1]?.[0].payload.agentPreset).toBe('aidev')
    await router.stop()
  })

  it('rejects a user outside the configured allowlist before creating a session', async () => {
    const test = harness()
    const router = new WeComConversationRouter(test.api, test.replies, logger(), {
      allowedUsers: ['allowed-user'],
      adminUsers: [],
      thinkingText: '处理中',
      turnTimeoutMs: 1_000,
    }, runtime())
    router.start()
    router.accept(textFrame())

    await vi.waitFor(() => {
      expect(test.replyCalls).toEqual([{
        content: '你没有权限使用这个机器人。\n你的 userid 是：user-1\n请让管理员把它填进「允许的用户 ID」。',
        finish: true,
      }])
    })
    expect(test.create).not.toHaveBeenCalled()
    expect(test.prompt).not.toHaveBeenCalled()

    await router.stop()
  })

  it('answers /whoami for a user no list admits', async () => {
    const test = harness()
    const router = new WeComConversationRouter(test.api, test.replies, logger(), {
      allowedUsers: [], adminUsers: ['admin'], thinkingText: '处理中', turnTimeoutMs: 1_000,
    }, runtime())
    router.start()
    router.accept(textFrame('/whoami'))

    await vi.waitFor(() => expect(test.replyCalls.at(-1)?.content).toContain('你的 userid 是：user-1'))
    expect(test.replyCalls.at(-1)?.content).not.toContain('只有机器人管理员')
    expect(test.prompt).not.toHaveBeenCalled()
    await router.stop()
  })

  it('lets an administrator create and persist a new conversation session', async () => {
    const test = harness()
    const set = vi.fn(async () => undefined)
    const router = new WeComConversationRouter(test.api, test.replies, logger(), {
      allowedUsers: [], adminUsers: ['user-1'], thinkingText: '处理中', turnTimeoutMs: 1_000,
    }, {
      defaultWorkspace: defaultWorkspace(),
      bindings: { current: (_key, fallback) => fallback, set },
    })
    router.start()
    router.accept(textFrame('/new'))

    await vi.waitFor(() => expect(set).toHaveBeenCalledTimes(1))
    expect(test.prompt).not.toHaveBeenCalled()
    expect(test.create).toHaveBeenCalledTimes(2)
    expect(test.create.mock.calls.every(([request]) => request.payload.workspaceId === 'workspace-wecom')).toBe(true)
    expect(test.replyCalls.at(-1)?.content).toContain('已创建并切换到新会话')
    await router.stop()
  })

  it('switches one conversation to a selected Workspace and routes its next message there', async () => {
    const test = harness()
    let boundSession: string | undefined
    const bindings = {
      current: (_key: string, fallback: string) => boundSession ?? fallback,
      set: async (_key: string, sessionId: string) => { boundSession = sessionId },
    }
    const router = new WeComConversationRouter(test.api, test.replies, logger(), {
      allowedUsers: [], adminUsers: ['user-1'], thinkingText: '处理中', turnTimeoutMs: 1_000,
    }, {
      defaultWorkspace: defaultWorkspace(),
      bindings,
    })
    router.start()
    router.accept(textFrame('/workspace 项目 Alpha'))

    await vi.waitFor(() => {
      expect(test.replyCalls.at(-1)?.content).toContain('已切换到工作区“项目 Alpha”')
    })
    const switchedSession = boundSession
    expect(switchedSession).toMatch(/^session-wecom-[a-f0-9]{32}$/)

    router.accept(textFrame('继续处理项目', 'user-1', 'single', 'message-after-switch'))
    await vi.waitFor(() => expect(test.replyCalls.at(-1)).toEqual({ content: '你好，世界', finish: true }))
    expect(test.prompt.mock.calls.at(-1)?.[0].payload.sessionId).toBe(switchedSession)
    expect(test.create.mock.calls.some(([request]) => (
      request.payload.sessionId === switchedSession
      && request.payload.workspaceId === 'workspace-project'
    ))).toBe(true)
    await router.stop()
  })

  it('recognizes a management command after the bot mention in a group', async () => {
    const test = harness()
    const router = new WeComConversationRouter(test.api, test.replies, logger(), {
      allowedUsers: [], adminUsers: ['user-1'], thinkingText: '处理中', turnTimeoutMs: 1_000,
    }, runtime())
    router.start()
    router.accept(textFrame('@dsh /help', 'user-1', 'group'))

    await vi.waitFor(() => expect(test.replyCalls.at(-1)?.content).toContain('/status'))
    expect(test.prompt).not.toHaveBeenCalled()
    await router.stop()
  })

  it('changes effort only for administrators and validates against the current model', async () => {
    const test = harness()
    const router = new WeComConversationRouter(test.api, test.replies, logger(), {
      allowedUsers: [], adminUsers: ['user-1'], thinkingText: '处理中', turnTimeoutMs: 1_000,
    }, runtime())
    router.start()
    router.accept(textFrame('/effort off'))

    await vi.waitFor(() => expect(test.selectModel).toHaveBeenCalledTimes(1))
    expect(test.selectModel.mock.calls[0]?.[0].payload).toMatchObject({
      provider: 'deepseek', model: 'deepseek-chat', reasoningEffort: 'off',
    })
    expect(test.prompt).not.toHaveBeenCalled()
    expect(test.replyCalls.at(-1)?.content).toContain('Effort 已切换为 off')
    // Upstream saves every selection as the deployment default, so the channel
    // may not present the switch as WeCom-local.
    expect(test.replyCalls.at(-1)?.content).toContain('全局默认模型')
    await router.stop()
  })

  it('warns that switching the model reaches the deployment default', async () => {
    const test = harness()
    const router = new WeComConversationRouter(test.api, test.replies, logger(), {
      allowedUsers: [], adminUsers: ['user-1'], thinkingText: '处理中', turnTimeoutMs: 1_000,
    }, runtime())
    router.start()
    router.accept(textFrame('/model deepseek deepseek-chat high'))

    await vi.waitFor(() => expect(test.replyCalls.at(-1)?.content).toContain('已切换到 deepseek'))
    expect(test.replyCalls.at(-1)?.content).toContain('全局默认模型')
    await router.stop()
  })

  it('lists presets and reports the inherited default when none is pinned', async () => {
    const test = harness()
    const router = new WeComConversationRouter(test.api, test.replies, logger(), {
      allowedUsers: [], adminUsers: ['user-1'], thinkingText: '处理中', turnTimeoutMs: 1_000,
    }, runtime())
    router.start()
    router.accept(textFrame('/preset'))

    await vi.waitFor(() => expect(test.replyCalls.at(-1)?.content).toContain('可选预设'))
    const listing = test.replyCalls.at(-1)?.content ?? ''
    expect(listing).toContain('跟随全局默认（standard）')
    expect(listing).toContain('dsh-security-audit（安全审计）')
    expect(listing).toContain('不可用：缺少 agent.cordis.yml')
    expect(test.prompt).not.toHaveBeenCalled()
    await router.stop()
  })

  it('persists a preset switch to channel settings and rebuilds the session on it', async () => {
    const test = harness()
    const writeSettings = vi.fn(async (_section: { agentPreset?: string | undefined }) => undefined)
    let boundSession: string | undefined
    const router = new WeComConversationRouter(test.api, test.replies, logger(), {
      allowedUsers: [], adminUsers: ['user-1'], thinkingText: '处理中', turnTimeoutMs: 1_000,
    }, {
      defaultWorkspace: defaultWorkspace(),
      bindings: {
        current: (_key, fallback) => boundSession ?? fallback,
        set: async (_key, sessionId) => { boundSession = sessionId },
      },
    }, writeSettings)
    router.start()
    router.accept(textFrame('/preset dsh-security-audit'))

    await vi.waitFor(() => expect(test.replyCalls.at(-1)?.content).toContain('已切换到预设“dsh-security-audit”'))
    expect(writeSettings).toHaveBeenCalledWith({ agentPreset: 'dsh-security-audit' })
    expect(test.create.mock.calls.some(([request]) => (
      request.payload.sessionId === boundSession
      && request.payload.agentPreset === 'dsh-security-audit'
    ))).toBe(true)
    await router.stop()
  })

  it('clears the pinned preset on reset so new sessions inherit the default', async () => {
    const test = harness()
    const writeSettings = vi.fn(async (_section: { agentPreset?: string | undefined }) => undefined)
    let boundSession: string | undefined
    const router = new WeComConversationRouter(test.api, test.replies, logger(), {
      allowedUsers: [], adminUsers: ['user-1'], agentPreset: 'dsh-security-audit',
      thinkingText: '处理中', turnTimeoutMs: 1_000,
    }, {
      defaultWorkspace: defaultWorkspace(),
      bindings: {
        current: (_key, fallback) => boundSession ?? fallback,
        set: async (_key, sessionId) => { boundSession = sessionId },
      },
    }, writeSettings)
    router.start()
    router.accept(textFrame('/preset reset'))

    await vi.waitFor(() => expect(test.replyCalls.at(-1)?.content).toContain('已恢复跟随全局默认预设'))
    expect(writeSettings).toHaveBeenCalledWith({ agentPreset: undefined })
    expect(test.create.mock.calls.some(([request]) => (
      request.payload.sessionId === boundSession
      && request.payload.agentPreset === undefined
    ))).toBe(true)
    await router.stop()
  })

  it('refuses an unknown preset without writing settings', async () => {
    const test = harness()
    const writeSettings = vi.fn(async (_section: { agentPreset?: string | undefined }) => undefined)
    const router = new WeComConversationRouter(test.api, test.replies, logger(), {
      allowedUsers: [], adminUsers: ['user-1'], thinkingText: '处理中', turnTimeoutMs: 1_000,
    }, runtime(), writeSettings)
    router.start()
    router.accept(textFrame('/preset nope'))

    await vi.waitFor(() => expect(test.replyCalls.at(-1)?.content).toContain('没有找到预设“nope”'))
    expect(writeSettings).not.toHaveBeenCalled()
    await router.stop()
  })

  it('reports a rejected preset write instead of claiming the switch landed', async () => {
    const test = harness()
    const writeSettings = vi.fn(async () => { throw new Error('settings provider is read-only') })
    const router = new WeComConversationRouter(test.api, test.replies, logger(), {
      allowedUsers: [], adminUsers: ['user-1'], thinkingText: '处理中', turnTimeoutMs: 1_000,
    }, runtime(), writeSettings)
    router.start()
    router.accept(textFrame('/preset standard'))

    await vi.waitFor(() => expect(test.replyCalls.at(-1)?.content).toContain('预设未能保存'))
    expect(test.replyCalls.at(-1)?.content).toContain('settings provider is read-only')
    await router.stop()
  })

  it('still switches presets where the deployment exposes no preset roster', async () => {
    const test = harness()
    test.listPresets.mockImplementation(async request => ({
      rpcId: request.rpcId,
      result: { ok: false as const, error: { code: 'presets-unavailable', message: 'no registry' } },
    }))
    const writeSettings = vi.fn(async (_section: { agentPreset?: string | undefined }) => undefined)
    const router = new WeComConversationRouter(test.api, test.replies, logger(), {
      allowedUsers: [], adminUsers: ['user-1'], thinkingText: '处理中', turnTimeoutMs: 1_000,
    }, runtime(), writeSettings)
    router.start()
    router.accept(textFrame('/preset aidev'))

    await vi.waitFor(() => expect(test.replyCalls.at(-1)?.content).toContain('已切换到预设“aidev”'))
    expect(writeSettings).toHaveBeenCalledWith({ agentPreset: 'aidev' })
    await router.stop()
  })

  it('refuses management commands from a non-administrator', async () => {
    const test = harness()
    const router = new WeComConversationRouter(test.api, test.replies, logger(), {
      allowedUsers: [], adminUsers: ['admin'], thinkingText: '处理中', turnTimeoutMs: 1_000,
    }, runtime())
    router.start()
    router.accept(textFrame('/new'))

    await vi.waitFor(() => expect(test.replyCalls.at(-1)?.content).toContain('只有机器人管理员'))
    expect(test.replyCalls.at(-1)?.content).toContain('你的 userid 是：user-1')
    expect(test.create).toHaveBeenCalledTimes(1)
    expect(test.prompt).not.toHaveBeenCalled()
    await router.stop()
  })

  it('admits a busy-session message as guidance without waiting for the active turn', async () => {
    const test = harness()
    test.prompt
      .mockImplementationOnce(async request => success(request, {
        accepted: true as const, disposition: 'next-turn' as const,
      }))
      .mockImplementationOnce(async request => success(request, {
        accepted: true as const, disposition: 'next-step' as const,
      }))
    const router = new WeComConversationRouter(test.api, test.replies, logger(), {
      allowedUsers: [], adminUsers: [], thinkingText: '处理中', turnTimeoutMs: 1_000,
    }, runtime())
    router.start()
    router.accept(textFrame('先处理这个', 'user-1', 'single', 'message-1'))
    await vi.waitFor(() => {
      const sessionId = test.prompt.mock.calls[0]?.[0].payload.sessionId as string | undefined
      expect(sessionId === undefined ? false : router.ownsSession(sessionId)).toBe(true)
    })

    router.accept(textFrame('再注意这个条件', 'user-1', 'single', 'message-2'))
    await vi.waitFor(() => expect(test.prompt).toHaveBeenCalledTimes(2))
    await vi.waitFor(() => {
      expect(test.reliableCalls).toContainEqual({ content: '已加入当前任务。', finish: true })
    })
    expect(test.prompt.mock.calls.map(([request]) => request.payload.mode)).toEqual(['queue', 'steer'])

    await router.stop()
  })

  it('settles an approval from the live nested WeCom card callback without queueing a turn', async () => {
    const test = harness()
    test.prompt.mockImplementationOnce(async (request: RpcRequest<{
      sessionId: string
      mode: 'queue' | 'steer'
      content: [{ type: 'text'; text: string }]
    }>) => success(request, { accepted: true as const, disposition: 'next-turn' as const }))
    const router = new WeComConversationRouter(test.api, test.replies, logger(), {
      allowedUsers: [], adminUsers: [], thinkingText: '处理中', turnTimeoutMs: 1_000,
    }, runtime())
    router.start()
    router.accept(textFrame('请执行操作', 'user-1', 'group'))
    await vi.waitFor(() => expect(test.prompt).toHaveBeenCalledTimes(1))
    const sessionId = test.prompt.mock.calls[0]?.[0].payload.sessionId as string
    const promptRpcId = test.prompt.mock.calls[0]?.[0].rpcId as string
    test.pushMux(event(sessionId, 0, 'agent/inbox/spliced', {
      inserted: [{ source: { kind: 'user', rpcId: promptRpcId } }],
    }))
    test.pushMux(event(sessionId, 1, 'turn/start', { turn: 1 }))
    test.pushMux(event(sessionId, 2, 'step/start', { turn: 1, step: 1 }))
    test.pushMux(event(sessionId, 3, 'assistant/chunk', {
      turn: 1, step: 1, chunk: { type: 'text-delta', index: 0, text: '审批前说明' },
    }))
    await vi.waitFor(() => {
      expect(test.streamCalls.some(call => call.content === '审批前说明')).toBe(true)
    })
    test.history.mockImplementationOnce(async request => success(request, {
      events: [{
        event: {
          type: 'tool/call',
          seq: 4,
          data: {
            turn: 1,
            step: 1,
            callId: 'approval-call',
            name: 'bash',
            arguments: JSON.stringify({ command: 'printf "approved" > /tmp/dsh-approval.txt' }),
          },
        },
      }],
      hasMore: false,
    }))

    let publishResolution: ((value: { outcome: 'allowed-once' }) => void) | undefined
    const resolved = new Promise<{ outcome: 'allowed-once' }>((resolve) => {
      publishResolution = resolve
    })
    const approval = router.requestApproval({
      id: 'approval-1',
      sessionId,
      toolName: 'bash',
      callId: 'approval-call',
      reason: '需要访问工作区之外的受保护目录，并执行一次需要额外权限的操作',
      resolved,
    })
    await vi.waitFor(() => {
      expect(test.sentCards).toHaveLength(1)
    })
    expect(test.sentCards[0]).toMatchObject({
      targetId: 'group-1',
      card: {
        card_type: 'button_interaction',
        main_title: { title: '需要审批', desc: '工具：bash' },
        sub_title_text: '需要访问工作区之外的受保护目录，并执行一次需要额外权限的操作',
        quote_area: {
          type: 0,
          title: '执行命令',
          quote_text: 'printf "approved" > /tmp/dsh-approval.txt',
        },
        button_list: [
          { text: '允许', key: 'approval_allow', style: 1 },
          { text: '拒绝', key: 'approval_reject', style: 2 },
        ],
      },
    })
    expect(test.streamCalls.some(call => call.reqId === 'wecom-request'
      && call.content.includes('点击卡片按钮') && call.finish)).toBe(true)
    const taskId = test.sentCards[0]?.card.task_id as string

    router.acceptTemplateCardEvent(cardEvent(taskId, 'approval_allow', 'user-2'))
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(test.updatedCards).toEqual([])

    router.acceptTemplateCardEvent(cardEvent(taskId, 'approval_allow'))
    await expect(approval).resolves.toMatchObject({
      outcome: 'allowed-once',
      actorRef: expect.stringMatching(/^wecom:[a-f0-9]{64}$/),
    })
    expect(test.prompt).toHaveBeenCalledTimes(1)
    await vi.waitFor(() => {
      expect(test.updatedCards.at(-1)).toMatchObject({
        card_type: 'button_interaction',
        main_title: { title: '已允许', desc: '任务继续执行' },
        card_action: { type: 0 },
        button_list: [{ text: '已处理', key: 'resolved_noop', style: 2 }],
        replace_text: '操作成功',
        task_id: taskId,
      })
    })

    publishResolution?.({ outcome: 'allowed-once' })
    test.pushMux(event(sessionId, 4, 'step/start', { turn: 1, step: 2 }))
    test.pushMux(event(sessionId, 5, 'assistant/chunk', {
      turn: 1, step: 2, chunk: { type: 'text-delta', index: 0, text: '审批后结果' },
    }))
    test.pushMux(event(sessionId, 6, 'turn/end', {
      turn: 1, reason: { kind: 'completed' },
    }))
    await vi.waitFor(() => {
      expect(test.proactiveTexts).toContainEqual({ targetId: 'group-1', content: '审批后结果' })
    })
    await router.stop()
  })

  it('acknowledges text approval separately and sends resumed output as a new message', async () => {
    const test = harness()
    test.prompt.mockImplementationOnce(async request => success(request, {
      accepted: true as const, disposition: 'next-turn' as const,
    }))
    const router = new WeComConversationRouter(test.api, test.replies, logger(), {
      allowedUsers: [], adminUsers: [], thinkingText: '处理中', turnTimeoutMs: 1_000,
    }, runtime())
    router.start()
    router.accept(textFrame('请执行操作', 'user-1', 'group'))
    await vi.waitFor(() => expect(test.prompt).toHaveBeenCalledTimes(1))
    const sessionId = test.prompt.mock.calls[0]?.[0].payload.sessionId as string
    const promptRpcId = test.prompt.mock.calls[0]?.[0].rpcId as string
    test.pushMux(event(sessionId, 0, 'agent/inbox/spliced', {
      inserted: [{ source: { kind: 'user', rpcId: promptRpcId } }],
    }))
    test.pushMux(event(sessionId, 1, 'turn/start', { turn: 1 }))
    test.pushMux(event(sessionId, 2, 'step/start', { turn: 1, step: 1 }))
    test.pushMux(event(sessionId, 3, 'assistant/chunk', {
      turn: 1, step: 1, chunk: { type: 'text-delta', index: 0, text: '审批前说明' },
    }))
    await vi.waitFor(() => expect(router.ownsSession(sessionId)).toBe(true))
    let publishResolution: ((value: { outcome: 'allowed-once' }) => void) | undefined
    const resolved = new Promise<{ outcome: 'allowed-once' }>((resolve) => {
      publishResolution = resolve
    })
    const approval = router.requestApproval({
      id: 'approval-text', sessionId, toolName: 'bash', resolved,
    })
    await vi.waitFor(() => expect(test.sentCards).toHaveLength(1))
    const initialStreamId = test.streamCalls.find(call => call.reqId === 'wecom-request')?.streamId

    router.accept(textFrame(
      '/approve', 'user-1', 'group', 'approval-answer', 'approval-answer-request',
    ))
    await expect(approval).resolves.toMatchObject({ outcome: 'allowed-once' })
    publishResolution?.({ outcome: 'allowed-once' })

    await vi.waitFor(() => {
      expect(test.streamCalls.some(call => call.reqId === 'approval-answer-request'
        && call.streamId !== initialStreamId && call.content.includes('已允许本次操作')
        && call.finish)).toBe(true)
    })
    test.pushMux(event(sessionId, 4, 'step/start', { turn: 1, step: 2 }))
    test.pushMux(event(sessionId, 5, 'assistant/chunk', {
      turn: 1, step: 2, chunk: { type: 'text-delta', index: 0, text: '审批后的新结果' },
    }))
    test.pushMux(event(sessionId, 6, 'turn/end', {
      turn: 1, reason: { kind: 'completed' },
    }))
    await vi.waitFor(() => {
      expect(test.proactiveTexts).toContainEqual({
        targetId: 'group-1', content: '审批后的新结果',
      })
    })
    expect(test.streamCalls.some(call => call.content.includes('审批后的新结果'))).toBe(false)
    await router.stop()
  })

  it('withdraws its approval candidate when another answerer wins', async () => {
    const test = harness()
    test.prompt.mockImplementationOnce(async request => success(request, {
      accepted: true as const, disposition: 'next-turn' as const,
    }))
    const router = new WeComConversationRouter(test.api, test.replies, logger(), {
      allowedUsers: [], adminUsers: [], thinkingText: '处理中', turnTimeoutMs: 1_000,
    }, runtime())
    router.start()
    router.accept(textFrame('请执行操作', 'user-1', 'group'))
    await vi.waitFor(() => expect(test.prompt).toHaveBeenCalledTimes(1))
    const sessionId = test.prompt.mock.calls[0]?.[0].payload.sessionId as string
    await vi.waitFor(() => expect(router.ownsSession(sessionId)).toBe(true))

    const controller = new AbortController()
    let publishResolution: ((value: { outcome: 'rejected' }) => void) | undefined
    const resolved = new Promise<{ outcome: 'rejected' }>((resolve) => {
      publishResolution = resolve
    })
    const approval = router.requestApproval({
      id: 'approval-web-wins', sessionId, toolName: 'bash',
      signal: controller.signal, resolved,
    })
    await vi.waitFor(() => {
      expect(test.sentCards).toHaveLength(1)
    })
    const taskId = test.sentCards[0]?.card.task_id as string

    controller.abort()
    await expect(approval).resolves.toBeUndefined()
    publishResolution?.({ outcome: 'rejected' })
    await new Promise(resolve => setTimeout(resolve, 0))
    router.acceptTemplateCardEvent(cardEvent(taskId, 'approval_allow'))
    await vi.waitFor(() => {
      expect(test.updatedCards.at(-1)).toMatchObject({
        card_type: 'button_interaction',
        main_title: { title: '审批已拒绝。' },
        card_action: { type: 0 },
        button_list: [{ text: '已处理', key: 'resolved_noop', style: 2 }],
        replace_text: '操作成功',
        task_id: taskId,
      })
    })
    await router.stop()
  })

  it('answers a Host question batch from the originating WeCom conversation', async () => {
    const test = harness()
    test.prompt.mockImplementationOnce(async request => success(request, {
      accepted: true as const, disposition: 'next-turn' as const,
    }))
    const router = new WeComConversationRouter(test.api, test.replies, logger(), {
      allowedUsers: [], adminUsers: [], thinkingText: '处理中', turnTimeoutMs: 1_000,
    }, runtime())
    router.start()
    router.accept(textFrame('请执行需要确认的任务', 'user-1', 'group'))
    await vi.waitFor(() => expect(test.prompt).toHaveBeenCalledTimes(1))
    const sessionId = test.prompt.mock.calls[0]?.[0].payload.sessionId as string
    await vi.waitFor(() => expect(router.ownsSession(sessionId)).toBe(true))

    test.pushMux({
      rpcId: 'question-rpc-1',
      payload: {
        type: 'question/requested',
        sessionId,
        questions: [{
          id: 'method',
          header: '验证方式',
          question: '你想怎么验证？',
          options: [{ label: '受控读取', description: '不会写入文件' }, { label: '受控写入' }],
        }, {
          id: 'scope',
          question: '在哪个客户端确认？',
          options: [{ label: '企业微信' }, { label: 'Web' }],
        }, {
          id: 'checks',
          question: '还要检查哪些结果？',
          options: [{ label: '企微提示' }, { label: 'Web 收起' }],
          multiSelect: true,
        }],
      },
    })
    await vi.waitFor(() => {
      expect(test.sentCards).toHaveLength(1)
    })
    expect(test.sentCards[0]?.card).toMatchObject({
      card_type: 'button_interaction',
      main_title: { title: '验证方式', desc: '你想怎么验证？' },
      button_list: [
        { text: '受控读取', key: 'question_0_option_0', style: 1 },
        { text: '受控写入', key: 'question_0_option_1', style: 2 },
      ],
    })
    const taskId = test.sentCards[0]?.card.task_id as string

    router.acceptTemplateCardEvent(cardEvent(taskId, 'question_0_option_1', 'user-2'))
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(test.respond).not.toHaveBeenCalled()
    expect(test.updatedCards).toEqual([])

    router.acceptTemplateCardEvent(cardEvent(taskId, 'question_0_option_1'))
    await vi.waitFor(() => {
      expect(test.updatedCards.at(-1)).toMatchObject({
        card_type: 'button_interaction',
        main_title: { desc: '在哪个客户端确认？' },
        button_list: [
          { text: '企业微信', key: 'question_1_option_0' },
          { text: 'Web', key: 'question_1_option_1' },
        ],
        task_id: taskId,
      })
    })
    expect(test.respond).not.toHaveBeenCalled()

    router.acceptTemplateCardEvent(cardEvent(taskId, 'question_0_option_1'))
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(test.updatedCards).toHaveLength(1)

    router.acceptTemplateCardEvent(cardEvent(taskId, 'question_1_option_0'))
    await vi.waitFor(() => {
      expect(test.updatedCards.at(-1)).toMatchObject({
        card_type: 'button_interaction',
        main_title: { title: '已记录选择，请按消息提示继续回答' },
        card_action: { type: 0 },
        button_list: [{ text: '已处理', key: 'resolved_noop', style: 2 }],
        replace_text: '操作成功',
        task_id: taskId,
      })
    })

    router.accept(textFrame('/answer checks 1,2,补充检查日志', 'user-1', 'group', 'answer-2'))
    await vi.waitFor(() => expect(test.respond).toHaveBeenCalledTimes(1))
    expect(test.respond.mock.calls[0]?.[0]).toEqual({
      type: 'client-response',
      rpcId: 'question-rpc-1',
      result: {
        ok: true,
        value: {
          sessionId,
          answer: { answers: [
            { id: 'method', selected: ['受控写入'] },
            { id: 'scope', selected: ['企业微信'] },
            {
            id: 'checks',
            selected: ['企微提示', 'Web 收起'],
            custom: '补充检查日志',
            },
          ] },
        },
      },
    })
    expect(test.prompt).toHaveBeenCalledTimes(1)
    expect(test.replyCalls.some(call => call.content === '答案已提交，任务继续执行。')).toBe(true)

    test.pushMux({
      rpcId: 'question-resolution-1',
      payload: {
        type: 'question/resolved', sessionId,
        questionRpcId: 'question-rpc-1', outcome: 'answered',
      },
    })
    await new Promise(resolve => setTimeout(resolve, 0))
    router.accept(textFrame('/answer 1 1', 'user-1', 'group', 'answer-after-resolved'))
    await vi.waitFor(() => {
      expect(test.replyCalls.some(call => call.content === '当前没有待回答的问题。')).toBe(true)
    })
    expect(test.respond).toHaveBeenCalledTimes(1)
    await router.stop()
  })

  it('delegates approvals that do not belong to an active WeCom turn', async () => {
    const test = harness()
    const router = new WeComConversationRouter(test.api, test.replies, logger(), {
      allowedUsers: [], adminUsers: [], thinkingText: '处理中', turnTimeoutMs: 1_000,
    }, runtime())

    await expect(router.requestApproval({
      id: 'approval-other',
      sessionId: 'session-other',
      toolName: 'bash',
      resolved: Promise.resolve({ outcome: 'unavailable' }),
    })).resolves.toBeUndefined()
  })
})
