import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Logger } from '@deepseek-ai/cordis'
import { Context } from '@deepseek-ai/cordis'
import type { ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import { EventType, MessageType } from '@wecom/aibot-node-sdk'
import type { TemplateCard, WsFrame } from '@wecom/aibot-node-sdk'
import { describe, expect, it, vi } from 'vitest'
import type {
  AskUserQuestionItem,
  HostApiProxy,
  HostMuxFrame,
  RpcRequest,
  RpcResponse,
} from '../../src/adapters/wecom/host-api.js'
import { createHostApi } from '../../src/adapters/wecom/host-api.js'
import { normalizeTextFrame, promptRpcIdFor } from '../../src/adapters/wecom/inbound.js'
import type { WeComTextFrame } from '../../src/adapters/wecom/inbound.js'
import { WeComConversationRouter } from '../../src/adapters/wecom/router.js'
import { ConversationBindings } from '../../src/adapters/wecom/bindings.js'
import { MAX_STREAM_REPLY_BYTES } from '../../src/adapters/wecom/reply.js'
import { Config, configuredBots, resolveRuntimeConfig } from '../../src/adapters/wecom/config.js'
import type { WeComReplyClient, WeComTemplateCardEventFrame } from '../../src/adapters/wecom/router.js'

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
      list: async request => ({ rpcId: request.rpcId, result: { ok: true as const, value: { items: [] } } }),
      cancel: async request => ({ rpcId: request.rpcId, result: { ok: true as const, value: { accepted: true as const } } }),
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
      list: (_key: string, fallback: string) => [fallback],
      set: vi.fn(async () => undefined),
    },
    ...test === undefined ? {} : { readImage: test.readImage },
  })

  it('submits turns from two schema-resolved Bots with inherited models into separate Sessions', async () => {
    const bots = configuredBots(Config({ bots: [{ id: 'alpha' }, { id: 'beta' }] }))
    const tests = bots.map(() => harness())
    const routers = bots.map((bot, index) => {
      const test = tests[index]!
      return new WeComConversationRouter(test.api, test.replies, logger(), resolveRuntimeConfig(bot), runtime())
    })
    try {
      routers.forEach((router, index) => {
        router.start()
        const frame = textFrame()
        frame.body!.aibotid = bots[index]!.id
        router.accept(frame)
      })
      await vi.waitFor(() => {
        for (const test of tests) expect(test.replyCalls.at(-1)).toEqual({ content: '你好，世界', finish: true })
      })
      const created = tests.map(test => test.create.mock.calls[0]![0].payload)
      expect(created[0]!.sessionId).not.toBe(created[1]!.sessionId)
      for (const request of created) expect(request).not.toHaveProperty('model')
      for (const test of tests) expect(test.prompt).toHaveBeenCalledTimes(1)
    } finally { await Promise.all(routers.map(router => router.stop())) }
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
    ['session/conflict', 'existing cwd differs'],
    ['agent-preset-conflict', 'existing preset differs'],
    ['agent-preset/conflict', 'existing preset differs'],
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
      bindings: { current: (_key, fallback) => fallback, list: (_key, fallback) => [fallback], set },
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
      bindings: { current: (_key, fallback) => fallback, list: (_key, fallback) => [fallback], set },
    })
    router.start()
    router.accept(textFrame('/new'))

    await vi.waitFor(() => expect(set).toHaveBeenCalledTimes(1))
    expect(test.prompt).not.toHaveBeenCalled()
    expect(test.create).toHaveBeenCalledTimes(1)
    expect(test.create.mock.calls.every(([request]) => request.payload.workspaceId === 'workspace-wecom')).toBe(true)
    expect(test.replyCalls.at(-1)?.content).toContain('已创建并切换到新会话')
    await router.stop()
  })

  it('lists and switches only the current WeCom chat history, including after restart', async () => {
    const test = harness()
    const directory = await mkdtemp(join(tmpdir(), 'wecom-session-command-'))
    const file = join(directory, 'bindings.json')
    const makeRouter = (bindings: ConversationBindings) => new WeComConversationRouter(test.api, test.replies, logger(), {
      allowedUsers: [], adminUsers: ['user-1'], thinkingText: '处理中', turnTimeoutMs: 1_000,
    }, { defaultWorkspace: defaultWorkspace(), bindings })
    const bindings = await ConversationBindings.open(file)
    let router = makeRouter(bindings), sequence = 0
    const reply = async (text: string, user = 'user-1', group = false) => {
      const reqId = `session-command-${++sequence}`
      router.accept(textFrame(group ? `@dsh ${text}` : text, user, group ? 'group' : 'single', reqId, reqId))
      const finished = () => test.streamCalls.find(call => call.reqId === reqId && call.finish)
      await vi.waitFor(() => expect(finished()).toBeDefined())
      return finished()!.content
    }
    router.start()
    try {
      expect(await reply('/session')).toContain('还没有历史会话')
      expect(test.create).not.toHaveBeenCalled()
      expect(test.prompt).not.toHaveBeenCalled()
      await reply('开始处理任务')
      const first = test.prompt.mock.calls.at(-1)![0].payload.sessionId
      expect(await reply('/new')).toContain('/session')
      const second = test.create.mock.calls.at(-1)![0].payload.sessionId
      expect(second).not.toBe(first)
      const other = 'session-wecom-another-chat'
      await bindings.set('b'.repeat(64), other)
      const summaries = [
        { sessionId: first, title: '【企业微信】原任务', workspaceTitle: '项目 Alpha', running: false },
        { sessionId: second, title: '【企业微信】新任务', workspaceTitle: '项目 Alpha', running: true },
        { sessionId: other, title: '其他聊天的任务', running: false },
      ]
      test.api.sessions.list = vi.fn(async request => success(request, {
        items: summaries.filter(item => request.payload.sessionIds.includes(item.sessionId)),
      }))
      expect(await reply('/session')).toContain('[2] 新任务（当前 · 执行中） · 工作区：项目 Alpha\n- [1] 原任务')
      expect(test.api.sessions.list).toHaveBeenLastCalledWith(expect.objectContaining({ payload: { sessionIds: [first, second] } }))
      expect(await reply('/session', 'user-1', true)).toContain('还没有历史会话')
      expect(await reply('/session 1', 'guest')).toContain('只有机器人管理员')
      expect(await reply(`/session ${other}`)).toContain('没有找到')
      expect(await reply('/session 1')).toContain('已切换到会话：原任务')
      await router.stop()
      router = makeRouter(await ConversationBindings.open(file))
      router.start()
      expect(await reply('/session list 1')).toContain('[1] 原任务（当前）')
      await reply('继续原任务')
      expect(test.prompt.mock.calls.at(-1)![0].payload.sessionId).toBe(first)
      summaries.splice(0, 1)
      expect(await reply('/session 1')).toContain('没有找到')
    } finally {
      await router.stop()
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('switches one conversation to a selected Workspace and routes its next message there', async () => {
    const test = harness()
    let boundSession: string | undefined
    const bindings = {
      current: (_key: string, fallback: string) => boundSession ?? fallback,
      list: (_key: string, fallback: string) => [boundSession ?? fallback],
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
    expect(test.replyCalls.at(-1)?.content).toContain('仅作用于当前企微会话')
    await router.stop()
  })

  it('switches the model only for the current conversation', async () => {
    const test = harness()
    const router = new WeComConversationRouter(test.api, test.replies, logger(), {
      allowedUsers: [], adminUsers: ['user-1'], thinkingText: '处理中', turnTimeoutMs: 1_000,
    }, runtime())
    router.start()
    router.accept(textFrame('/model deepseek deepseek-chat high'))

    await vi.waitFor(() => expect(test.replyCalls.at(-1)?.content).toContain('已切换到 deepseek'))
    expect(test.replyCalls.at(-1)?.content).toContain('仅作用于当前企微会话')
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
        list: (_key, fallback) => [boundSession ?? fallback],
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
        list: (_key, fallback) => [boundSession ?? fallback],
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
    expect(test.create).not.toHaveBeenCalled()
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

  async function startQuestionTurn() {
    const test = harness()
    test.prompt.mockImplementationOnce(async request => success(request, {
      accepted: true as const, disposition: 'next-turn' as const,
    }))
    const router = new WeComConversationRouter(test.api, test.replies, logger(), {
      allowedUsers: [], adminUsers: [], thinkingText: '处理中', turnTimeoutMs: 10_000,
    }, runtime())
    router.start()
    router.accept(textFrame('请问我下一步怎么做', 'user-1', 'group'))
    await vi.waitFor(() => expect(test.prompt).toHaveBeenCalledTimes(1))
    const sessionId = test.prompt.mock.calls[0]![0].payload.sessionId
    await vi.waitFor(() => expect(router.ownsSession(sessionId)).toBe(true))
    const ask = (questions: AskUserQuestionItem[], rpcId = 'question-text') => test.pushMux({
      rpcId, payload: { type: 'question/requested', sessionId, questions },
    })
    const answer = (text: string) => router.accept(textFrame(text, 'user-1', 'group', `answer-${text}`))
    return { test, router, sessionId, ask, answer }
  }

  it.each([
    { field: 'a wide option', question: { options: [{ label: '整理完整回复' }, { label: '稍后' }] }, shown: '整理完整回复' },
    { field: 'a long title', question: { header: '请从下面确认接下来要怎么处理这项任务' }, shown: '请从下面确认接下来要怎么处理这项任务' },
    { field: 'a long question', question: { question: '你希望先整理已经收集的信息然后再发送给群里的其他参与者吗？' }, shown: '你希望先整理已经收集的信息然后再发送给群里的其他参与者吗？' },
    { field: 'multiline detail', question: { detail: '事项背景\n需要审核' }, shown: '事项背景\n需要审核' },
    { field: 'a long option description', question: { options: [{ label: '确认', description: '保留已经整理好的全部细节并附上后续处理建议' }] }, shown: '保留已经整理好的全部细节并附上后续处理建议' },
  ])('shows $field in text and accepts the numbered answer', async ({ question, shown }) => {
    const f = await startQuestionTurn()
    try {
      const item: AskUserQuestionItem = { id: 'choice', question: '选择下一步', options: [{ label: '确认' }], ...question }
      f.ask([item])
      await vi.waitFor(() => expect(f.test.replyCalls.at(-1)).toMatchObject({ finish: true, content: expect.stringContaining(shown) }))
      const notice = f.test.replyCalls.at(-1)!.content
      expect(notice).toContain('`/answer 1`')
      expect(notice).toContain(`- 1）${item.options![0]!.label}`)
      expect(f.test.sentCards).toEqual([])

      f.answer('/answer 1')
      await vi.waitFor(() => expect(f.test.respond).toHaveBeenCalledWith(expect.objectContaining({
        result: { ok: true, value: { sessionId: f.sessionId, answer: { answers: [{ id: 'choice', selected: [item.options![0]!.label] }] } } },
      })))
    } finally {
      await f.router.stop()
    }
  })

  it('closes a short question card when the next question in the batch needs text', async () => {
    const f = await startQuestionTurn()
    const longOption = '先整理完整回复，随后把结果同步到群里'
    try {
      f.ask([
        { id: 'timing', question: '现在开始吗？', options: [{ label: '开始' }] },
        { id: 'delivery', question: '怎么提交结果？', options: [{ label: longOption }, { label: '先发草稿' }] },
      ])
      await vi.waitFor(() => expect(f.test.sentCards).toHaveLength(1))
      expect(f.test.replyCalls.at(-1)?.content).toContain(`- 1）${longOption}`)
      const taskId = f.test.sentCards[0]!.card.task_id!
      f.router.acceptTemplateCardEvent(cardEvent(taskId, 'question_0_option_0'))
      await vi.waitFor(() => expect(f.test.updatedCards.at(-1)).toMatchObject({
        main_title: { desc: '回复 /answer 2 <答案>' }, replace_text: '操作成功',
      }))
      f.answer(`/answer 2 ${longOption}`)
      await vi.waitFor(() => expect(f.test.respond).toHaveBeenCalledWith(expect.objectContaining({
        result: { ok: true, value: { sessionId: f.sessionId, answer: { answers: [
          { id: 'timing', selected: ['开始'] }, { id: 'delivery', selected: [longOption] },
        ] } } },
      })))
      expect(f.test.sentCards).toHaveLength(1)
    } finally {
      await f.router.stop()
    }
  })

  it('sends an oversized question in ordered UTF-8 text parts and keeps later questions answerable', async () => {
    const f = await startQuestionTurn()
    const detail = '🧭'.repeat(6000)
    try {
      f.ask([{ id: 'oversized', question: '继续吗？', detail, options: [{ label: '继续' }, { label: '下次处理' }] }])
      await vi.waitFor(() => expect(f.test.proactiveTexts.at(-1)?.content).toContain('- 2）下次处理'))
      const parts = f.test.proactiveTexts.map(message => message.content)
      expect(parts).toHaveLength(2)
      expect(parts.every(part => Buffer.byteLength(part) <= MAX_STREAM_REPLY_BYTES)).toBe(true)
      expect(parts.join('')).toContain(detail)
      expect(parts[0]).toContain('`/answer 1`')
      expect(f.test.replyCalls.at(-1)).toMatchObject({ finish: true, content: expect.stringContaining('接下来的消息') })
      expect(f.test.sentCards).toEqual([])

      f.answer('/answer 2')
      await vi.waitFor(() => expect(f.test.respond).toHaveBeenCalledTimes(1))
      f.test.pushMux({ rpcId: 'resolved', payload: {
        type: 'question/resolved', sessionId: f.sessionId, questionRpcId: 'question-text', outcome: 'answered',
      } })
      f.ask([{ id: 'followup', question: '还能补充什么？' }], 'follow-up')
      await vi.waitFor(() => expect(f.test.proactiveTexts.at(-1)?.content).toContain('还能补充什么？'))
      f.answer('/answer 补充测试结果')
      await vi.waitFor(() => expect(f.test.respond).toHaveBeenLastCalledWith(expect.objectContaining({
        rpcId: 'follow-up', result: { ok: true, value: { sessionId: f.sessionId, answer: { answers: [
          { id: 'followup', selected: [], custom: '补充测试结果' },
        ] } } },
      })))
    } finally {
      await f.router.stop()
    }
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

it('uploads and sends file and video attachments to the originating WeCom chat', async () => {
  const test = harness([], [
    { type: 'file', attachment: { attachmentId: 'report', name: 'report.txt', bytes: 4 } },
    { type: 'file', attachment: { attachmentId: 'video', name: 'video.mp4', bytes: 4 } },
  ])
  const router = new WeComConversationRouter(test.api, test.replies, logger(), {
    allowedUsers: [], adminUsers: [], thinkingText: '处理中', turnTimeoutMs: 1000,
  }, {
    bindings: { current: (_key, fallback) => fallback, list: (_key, fallback) => [fallback], set: async () => undefined },
    defaultWorkspace: { workspaceId: 'files', path: '/tmp', title: 'Files', sessionIds: [] },
    readFile: async function* () { yield Buffer.from('data') },
  })
  router.start(); router.accept(textFrame())
  try {
    await vi.waitFor(() => expect(test.sentMedia).toHaveLength(2))
    expect(test.uploads.map(file => [file.filename, file.bytes.toString()])).toEqual([['report.txt', 'data'], ['video.mp4', 'data']])
    expect(test.sentMedia.map(file => file.mediaType)).toEqual(['file', 'video'])
    expect(test.sentMedia[0]?.targetId).toBe(test.sentMedia[1]?.targetId)
  } finally { await router.stop() }
})

it('drains shutdown while prompt admission is still pending without an unhandled observation rejection', async () => {
  const test = harness()
  let entered!: () => void, release!: () => void
  const admission = new Promise<void>(resolve => { entered = resolve })
  const gate = new Promise<void>(resolve => { release = resolve })
  test.prompt.mockImplementation(async request => {
    entered(); await gate
    return success(request, { accepted: true as const, disposition: 'next-turn' as const })
  })
  const router = new WeComConversationRouter(test.api, test.replies, logger(), {
    allowedUsers: [], adminUsers: [], thinkingText: '处理中', turnTimeoutMs: 1000,
  }, {
    bindings: { current: (_key, fallback) => fallback, list: (_key, fallback) => [fallback], set: async () => undefined },
    defaultWorkspace: { workspaceId: 'shutdown', path: '/tmp', title: 'Shutdown', sessionIds: [] },
  })
  router.start(); router.accept(textFrame())
  await admission
  const stopped = router.stop()
  // Cross the rejection-notification boundary while admission remains blocked.
  await new Promise<void>(resolve => setImmediate(resolve))
  release()
  await stopped
})

it('releases a claimed Host question when shutdown precedes its channel presentation', async () => {
  const test = harness(), ctx = new Context()
  test.prompt.mockImplementation(async request => success(request, { accepted: true as const, disposition: 'next-turn' as const }))
  const router = new WeComConversationRouter(test.api, test.replies, logger(), {
    allowedUsers: [], adminUsers: [], thinkingText: '处理中', turnTimeoutMs: 5000,
  }, {
    bindings: { current: (_key, fallback) => fallback, list: (_key, fallback) => [fallback], set: async () => undefined },
    defaultWorkspace: { workspaceId: 'shutdown-question', path: '/tmp', title: 'Questions', sessionIds: [] },
  })
  ctx.provide('sessionController', {} as never)
  ctx.provide('workspaceRegistry', {} as never)
  let host!: HostApiProxy
  await ctx.plugin({ apply(inner: Context) {
    // Keep the Host question frame queued outside the retiring router's mux.
    host = createHostApi(inner, id => router.routesSession(id))
    test.api.releaseSession = sessionId => host.releaseSession?.(sessionId)
  } })
  const abort = new AbortController(), stream = host.events.mux({ rpcId: 'questions', payload: {} }, abort.signal)[Symbol.asyncIterator]()
  router.start()
  try {
    router.accept(textFrame())
    await vi.waitFor(() => expect(test.prompt).toHaveBeenCalledOnce())
    const sessionId = test.prompt.mock.calls[0]![0].payload.sessionId as string
    await vi.waitFor(() => expect(router.routesSession(sessionId)).toBe(true))
    const frame = stream.next()
    const question = ctx.waterfall('user-questions/request', {
      agent: { id: sessionId }, questions: [{ id: 'confirm', question: 'Continue?' }],
    } as never, async () => { throw new Error('Owned question must stay in channel') })
    const rejection = expect(question).rejects.toThrow('Channel session stopped')
    expect((await frame).value).toMatchObject({ payload: { type: 'question/requested', sessionId } })
    expect(test.sentCards).toEqual([])
    await router.stop()
    await rejection
  } finally { abort.abort(); await stream.return?.(); await router.stop(); await ctx.fiber.dispose() }
})
