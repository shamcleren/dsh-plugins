import { createHash, randomUUID } from 'node:crypto'
import type { Logger } from '@deepseek-ai/cordis'
import type { ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import type { ApprovalOutcome } from '@deepseek-ai/dsh-user-approval'
import type { ConversationBindings } from './bindings.js'
import type {
  AskUserQuestionAnswerItem,
  AskUserQuestionItem,
  HostApiProxy,
  HostMuxFrame,
  HostPreset,
  HostSessionEvent,
  HostWorkspace,
  QuestionRequestedFrame,
  QuestionResolvedFrame,
  RpcRequest,
} from './host-api.js'
import { HostApiError, unwrap, submitChannelPrompt } from './host-api.js'
import { conversationKeyFor, promptRpcIdFor, sessionIdFor } from './inbound.js'
import type { WeChatInboundMessage } from './inbound.js'
import { admittedPromptRpcIds, fallbackReply, TurnProjection } from './reply.js'
import type { WeChatRuntimeConfig, WeChatSettingsPatch } from './config.js'

const HISTORY_PAGE_MESSAGES = 100
const CONTINUATION_REPLY = '已加入当前任务。'
const COMMAND_PERMISSION_REPLY = '只有机器人管理员可以执行该命令。'
/**
 * Selecting a model is deployment-wide upstream: `sessions.selectModel` installs
 * the Session choice and then saves it as the default for every future Agent,
 * and the desktop client's own `/model` runs the same code. No public API sets a
 * Session model without that save, so the channel states the reach instead of
 * implying an isolation it cannot provide.
 */
const GLOBAL_MODEL_NOTICE = '注意：这会同时改变 DSH 的全局默认模型，桌面端之后新建的对话也会用它。'
const COMMAND_HELP = [
  '可用命令：',
  '/help - 查看命令',
  '/status - 查看当前模型与 effort',
  '/new - 新建并切换会话',
  '/workspace [名称或 ID|reset] - 查看或切换工作区',
  '/preset [<id>|reset] - 查看或切换本渠道的 Agent 预设',
  '/model [provider model [effort]] - 查看或切换模型（会改全局默认）',
  '/effort [level] - 查看或调整推理强度（会改全局默认）',
  '/compact - 压缩当前会话',
  '/answer <答案> - 回答当前交互问题',
].join('\n')

interface WeChatReplies {
  sendText(userId: string, text: string, contextToken?: string): Promise<void>
  sendImage(userId: string, bytes: Buffer, contextToken?: string): Promise<void>
  typing(userId: string, status: 1 | 2, contextToken?: string): Promise<void>
}

export interface RouterRuntimeContext {
  bindings: Pick<ConversationBindings, 'current' | 'set'>
  defaultWorkspace: HostWorkspace
  /** Absent on deployments without an attachment store; images then fall back to text. */
  readImage?: (ref: ImageAttachmentRef) => Promise<Uint8Array>
}

export interface ChannelApprovalRequest {
  id: string
  sessionId: string
  toolName: string
  callId?: string
  reason?: string
  signal?: AbortSignal
  resolved: Promise<{ outcome: ApprovalOutcome }>
}

export interface ChannelApprovalAnswer {
  outcome: 'allowed-once' | 'rejected'
  actorRef: string
}

interface ActiveTurn {
  sessionId: string
  conversationKey: string
  userId: string
  contextToken?: string
}

interface PendingApproval {
  activeTurn: ActiveTurn
  resolve(answer: ChannelApprovalAnswer | undefined): void
  signal?: AbortSignal
  abortListener?: () => void
}

interface PendingQuestion {
  rpcId: string
  activeTurn: ActiveTurn
  questions: AskUserQuestionItem[]
  answers: Map<string, AskUserQuestionAnswerItem>
}

type EventListener = (event: HostSessionEvent) => void

function apiRequest<T>(payload: T, rpcId = `wechat-api-${randomUUID()}`): RpcRequest<T> {
  return { rpcId, payload }
}

function maximumSeq(events: readonly { event: HostSessionEvent }[]): number {
  return events.reduce((highest, entry) => Math.max(highest, entry.event.seq), -1)
}

function promptText(message: WeChatInboundMessage): string | undefined {
  if (message.content.length !== 1 || message.content[0]?.type !== 'text') return undefined
  const text = message.content[0].text.trim()
  return text.startsWith('/') ? text : undefined
}

/** Announce images that follow as their own messages, so no reply arrives empty. */
const IMAGE_LEAD_IN = '图片如下：'

function undeliveredImageNotice(failed: number, total: number): string {
  const scope = failed === total ? `本轮生成的 ${failed} 张图片` : `本轮 ${total} 张图片中的 ${failed} 张`
  return `${scope}未能发送到微信，已保存在 DSH 会话中。`
}

function finalReply(completed: { text: string; images: readonly ImageAttachmentRef[]; reason: unknown }): string {
  if (completed.text !== '') return completed.text
  return completed.images.length > 0 ? IMAGE_LEAD_IN : fallbackReply(completed.reason)
}

/** Route iLink messages through durable Host sessions and return turn output to WeChat. */
export class WeChatConversationRouter {
  private readonly adminUsers: ReadonlySet<string>
  private readonly listeners = new Map<string, Set<EventListener>>()
  private readonly admissionTails = new Map<string, Promise<void>>()
  private readonly tasks = new Set<Promise<void>>()
  private readonly activeTurns = new Map<string, ActiveTurn>()
  private readonly pendingApprovals = new Map<string, PendingApproval>()
  private readonly pendingQuestions = new Map<string, PendingQuestion>()
  private readonly turnAborts = new Set<AbortController>()
  private muxAbort: AbortController | undefined
  private muxTask: Promise<void> | undefined
  private stopping = false
  /** Live channel preset; `/preset` moves it without reopening the accounts. */
  private agentPreset: string | undefined

  constructor(
    private readonly api: HostApiProxy,
    private readonly replies: WeChatReplies,
    private readonly logger: Logger,
    private readonly config: WeChatRuntimeConfig,
    private readonly runtime: RouterRuntimeContext,
    private readonly writeSettings: (section: WeChatSettingsPatch) => Promise<void>
      = () => Promise.reject(new Error('this deployment has no writable settings provider')),
  ) {
    this.adminUsers = new Set(config.adminUsers)
    this.agentPreset = config.agentPreset
  }

  /** Adopt a settings-side preset change without disturbing live conversations. */
  setAgentPreset(next: string | undefined): void {
    this.agentPreset = next
  }

  start(): void {
    if (this.muxTask !== undefined) return
    this.stopping = false
    this.muxAbort = new AbortController()
    this.muxTask = this.consumeMux(this.muxAbort.signal)
  }

  accept(message: WeChatInboundMessage): Promise<void> {
    if (this.stopping) return Promise.resolve()
    return this.track(this.route(message))
  }

  private track(operation: Promise<void>): Promise<void> {
    const task = operation.catch((error: unknown) => {
      this.logger.error(error)
      throw error
    })
    this.tasks.add(task)
    void task.catch(() => undefined)
    void task.finally(() => { this.tasks.delete(task) }).catch(() => undefined)
    return task
  }

  async stop(): Promise<void> {
    if (this.stopping) return
    this.stopping = true
    for (const pending of this.pendingApprovals.values()) this.withdrawApproval(pending)
    for (const abort of this.turnAborts) abort.abort()
    this.muxAbort?.abort()
    await this.muxTask
    await Promise.allSettled([...this.tasks])
    this.listeners.clear()
    this.activeTurns.clear()
    this.pendingQuestions.clear()
  }

  /** Route questions and events only while this channel owns the active turn. */
  routesSession(sessionId: string): boolean { return this.activeTurns.has(sessionId) }

  ownsSession(sessionId: string): boolean {
    const turn = this.activeTurns.get(sessionId)
    return turn !== undefined && this.adminUsers.has(turn.userId)
  }

  async requestApproval(request: ChannelApprovalRequest): Promise<ChannelApprovalAnswer | undefined> {
    const activeTurn = this.activeTurns.get(request.sessionId)
    if (activeTurn === undefined || !this.adminUsers.has(activeTurn.userId) || this.pendingApprovals.has(request.sessionId)) return undefined
    if (request.signal?.aborted === true) return undefined
    return await new Promise(resolve => {
      const pending: PendingApproval = {
        activeTurn,
        resolve,
        ...request.signal === undefined ? {} : { signal: request.signal },
      }
      if (request.signal !== undefined) {
        pending.abortListener = () => { this.withdrawApproval(pending) }
        request.signal.addEventListener('abort', pending.abortListener, { once: true })
      }
      this.pendingApprovals.set(request.sessionId, pending)
      const reason = request.reason === undefined ? '' : `\n原因：${request.reason}`
      void this.replies.sendText(
        activeTurn.userId,
        `需要你的审批\n工具：${request.toolName}${reason}\n回复 /approve 或 /reject。`,
        activeTurn.contextToken,
      ).catch((error: unknown) => {
        this.logger.error(error)
        this.withdrawApproval(pending)
      })
      void request.resolved.then(({ outcome }) => {
        if (this.pendingApprovals.get(request.sessionId) !== pending) return
        this.removeApproval(pending)
        const notice = outcome === 'allowed-once' ? '审批已通过，任务继续执行。' : '审批已结束。'
        return this.replies.sendText(activeTurn.userId, notice, activeTurn.contextToken)
      }).catch((error: unknown) => { this.logger.warn(`wechat: approval resolution failed: ${String(error)}`) })
    })
  }

  private async consumeMux(signal: AbortSignal): Promise<void> {
    try {
      for await (const message of this.api.events.mux(apiRequest({}), signal)) this.consumeMuxFrame(message)
      if (!this.stopping) throw new Error('wechat: Host event stream ended')
    } catch (error) {
      if (this.stopping) return
      for (const abort of this.turnAborts) abort.abort(error)
      this.logger.error(error)
    }
  }

  private consumeMuxFrame(message: RpcRequest<HostMuxFrame>): void {
    if (message.payload.type === 'session/event') {
      const frame = message.payload as Extract<HostMuxFrame, { type: 'session/event' }>
      for (const listener of this.listeners.get(frame.sessionId) ?? []) listener(frame.event)
      return
    }
    if (message.payload.type === 'question/requested') {
      this.presentQuestion(message.rpcId, message.payload as QuestionRequestedFrame)
      return
    }
    if (message.payload.type === 'question/resolved') this.resolveQuestion(message.payload as QuestionResolvedFrame)
  }

  private presentQuestion(rpcId: string, frame: QuestionRequestedFrame): void {
    const activeTurn = this.activeTurns.get(frame.sessionId)
    if (activeTurn === undefined || this.pendingQuestions.has(frame.sessionId)) return
    const pending: PendingQuestion = { rpcId, activeTurn, questions: frame.questions, answers: new Map() }
    this.pendingQuestions.set(frame.sessionId, pending)
    void this.replies.sendText(
      activeTurn.userId,
      `${this.formatQuestions(frame.questions)}\n回复 /answer <答案>；多题使用 /answer <序号或 id> <答案>。`,
      activeTurn.contextToken,
    ).catch((error: unknown) => {
      this.logger.error(error)
      this.pendingQuestions.delete(frame.sessionId)
    })
  }

  private resolveQuestion(frame: QuestionResolvedFrame): void {
    const pending = [...this.pendingQuestions.values()].find(candidate => candidate.rpcId === frame.questionRpcId)
    if (pending === undefined) return
    this.pendingQuestions.delete(pending.activeTurn.sessionId)
    const notice = frame.outcome === 'answered' ? '问题已回答，任务继续执行。' : '问题已取消。'
    void this.replies.sendText(pending.activeTurn.userId, notice, pending.activeTurn.contextToken)
      .catch((error: unknown) => { this.logger.warn(`wechat: question resolution failed: ${String(error)}`) })
  }

  private async route(message: WeChatInboundMessage): Promise<void> {
    const key = conversationKeyFor(message)
    const previous = this.admissionTails.get(key) ?? Promise.resolve()
    const current = previous.then(async () => { await this.admit(message, key) })
    const settled = current.catch(() => undefined)
    this.admissionTails.set(key, settled)
    try {
      await current
    } finally {
      if (this.admissionTails.get(key) === settled) this.admissionTails.delete(key)
    }
  }

  private async admit(message: WeChatInboundMessage, key: string): Promise<void> {
    if (await this.answerInteraction(message)) return
    const requested = this.runtime.bindings.current(key, sessionIdFor(message))
    const sessionId = await this.ensureSession(key, requested)
    const commandReply = await this.runManagementCommand(message, key, sessionId)
    if (commandReply !== undefined) {
      await this.replies.sendText(message.userId, commandReply, message.contextToken)
      return
    }
    await this.submitPrompt(message, key, sessionId)
  }

  private async runManagementCommand(
    message: WeChatInboundMessage,
    conversationKey: string,
    sessionId: string,
  ): Promise<string | undefined> {
    const text = promptText(message)
    if (text === undefined) return undefined
    const [command = '', ...args] = text.split(/\s+/u)
    if (command === '/compact' && args.length === 0) {
      return this.adminUsers.has(message.userId) ? undefined : COMMAND_PERMISSION_REPLY
    }
    if (!this.adminUsers.has(message.userId)) return COMMAND_PERMISSION_REPLY
    switch (command) {
      case '/help': return COMMAND_HELP
      case '/status': return await this.status(sessionId)
      case '/new': return args.length === 0 ? await this.newSession(conversationKey, sessionId) : '用法：/new'
      case '/workspace': return await this.workspace(conversationKey, sessionId, args)
      case '/preset': return await this.preset(conversationKey, sessionId, args)
      case '/model': return await this.model(sessionId, args)
      case '/effort': return await this.effort(sessionId, args)
      default: return `未知命令：${command}\n\n${COMMAND_HELP}`
    }
  }

  private async status(sessionId: string): Promise<string> {
    const models = unwrap(await this.api.sessions.models(apiRequest({ sessionId })))
    return [
      `当前模型：${models.current.provider} / ${models.current.model}`,
      `Effort：${models.current.reasoningEffort ?? '由模型或提供方决定'}`,
      `预设：${this.agentPreset ?? '跟随全局默认'}`,
    ].join('\n')
  }

  private async newSession(key: string, currentSessionId: string): Promise<string> {
    const workspaceId = await this.workspaceIdForSession(currentSessionId)
      ?? this.runtime.defaultWorkspace.workspaceId
    const sessionId = `session-wechat-${randomUUID().replaceAll('-', '')}`
    await this.createSession(sessionId, workspaceId)
    await this.runtime.bindings.set(key, sessionId)
    return '已创建并切换到新会话（当前工作区）。旧会话仍保留。'
  }

  private async workspace(key: string, currentSessionId: string, args: readonly string[]): Promise<string> {
    const workspaces = await this.listWorkspaces()
    const current = workspaces.find(entry => entry.sessionIds.includes(currentSessionId))
    if (args.length === 0) {
      return [`当前工作区：${current?.title ?? '未分组'}`, `默认工作区：${this.runtime.defaultWorkspace.title}`,
        '可选工作区：', ...workspaces.map(entry => `${entry.title} (${entry.workspaceId})`)].join('\n')
    }
    const selector = args.join(' ')
    const target = selector === 'reset'
      ? workspaces.find(entry => entry.workspaceId === this.runtime.defaultWorkspace.workspaceId)
      : this.selectWorkspace(workspaces, selector)
    if (target === undefined) return `没有找到工作区“${selector}”；发送 /workspace 查看可选项。`
    if (target.workspaceId === current?.workspaceId) return `当前已经在工作区“${target.title}”。`
    const sessionId = `session-wechat-${randomUUID().replaceAll('-', '')}`
    await this.createSession(sessionId, target.workspaceId)
    await this.runtime.bindings.set(key, sessionId)
    return `已切换到工作区“${target.title}”并创建新会话。旧会话仍保留。`
  }

  /**
   * Move the channel's agent preset.
   *
   * Unlike `/model`, this stays inside WeChat: the preset lives in this plugin's
   * own settings section, and a session names its preset at creation, so the
   * switch persists for the channel and takes effect on a rebuilt session
   * instead of leaking into any deployment-wide default.
   */
  private async preset(
    conversationKey: string,
    currentSessionId: string,
    args: readonly string[],
  ): Promise<string> {
    let roster: { items: readonly HostPreset[]; defaultId: string } | undefined
    try {
      roster = unwrap(await this.api.presets.list(apiRequest({})))
    } catch (error: unknown) {
      if (!(error instanceof HostApiError) || error.code !== 'presets-unavailable') throw error
    }
    const current = this.agentPreset
    if (args.length === 0) {
      const inherited = roster === undefined ? '全局默认' : `全局默认（${roster.defaultId}）`
      const rows = roster?.items.map(entry => {
        const label = entry.name === undefined ? entry.id : `${entry.id}（${entry.name}）`
        return entry.broken === undefined ? label : `${label} [不可用：${entry.broken}]`
      }) ?? ['（本部署未提供预设列表）']
      return [
        `当前预设：${current ?? `未指定，跟随${inherited}`}`,
        '可选预设：',
        ...rows,
        '',
        '用法：/preset <id> 切换，/preset reset 恢复跟随全局默认。',
      ].join('\n')
    }
    if (args.length !== 1) return '用法：/preset [<id>|reset]'
    const [selector] = args as [string]
    const next = selector === 'reset' ? undefined : selector
    if (next !== undefined && roster !== undefined) {
      const target = roster.items.find(entry => entry.id === next)
      if (target === undefined) return `没有找到预设“${next}”；发送 /preset 查看可选项。`
      if (target.broken !== undefined) return `预设“${next}”当前不可用：${target.broken}`
    }
    if (next === current) {
      return next === undefined ? '当前已经跟随全局默认预设。' : `当前已经在预设“${next}”。`
    }
    try {
      await this.writeSettings({ agentPreset: next })
    } catch (error: unknown) {
      return `预设未能保存：${error instanceof Error ? error.message : String(error)}`
    }
    // A running session keeps the preset it was composed from, so the switch only
    // becomes observable on a session created after the write.
    this.agentPreset = next
    const workspaceId = await this.workspaceIdForSession(currentSessionId)
      ?? this.runtime.defaultWorkspace.workspaceId
    const sessionId = `session-wechat-${randomUUID().replaceAll('-', '')}`
    await this.createSession(sessionId, workspaceId)
    await this.runtime.bindings.set(conversationKey, sessionId)
    return next === undefined
      ? '已恢复跟随全局默认预设，并创建新会话。旧会话仍保留。'
      : `已切换到预设“${next}”，并创建新会话。旧会话仍保留。`
  }

  private selectWorkspace(workspaces: readonly HostWorkspace[], selector: string): HostWorkspace | undefined {
    const byId = workspaces.find(entry => entry.workspaceId === selector)
    if (byId !== undefined) return byId
    const byTitle = workspaces.filter(entry => entry.title === selector)
    return byTitle.length === 1 ? byTitle[0] : undefined
  }

  private async workspaceIdForSession(sessionId: string): Promise<string | undefined> {
    return (await this.listWorkspaces()).find(workspace => workspace.sessionIds.includes(sessionId))?.workspaceId
  }

  private async listWorkspaces(): Promise<HostWorkspace[]> {
    return unwrap(await this.api.workspace.list(apiRequest({}))).items
  }

  private async model(sessionId: string, args: readonly string[]): Promise<string> {
    const models = unwrap(await this.api.sessions.models(apiRequest({ sessionId })))
    if (args.length === 0) {
      const rows = models.groups.flatMap(group => group.models.map(model => `${group.id} ${model.id}${model.reasoning?.efforts === undefined ? '' : ` [${model.reasoning.efforts.map(effort => effort.id).join(', ')}]`}`))
      return [`当前：${models.current.provider} ${models.current.model}`, ...rows].join('\n')
    }
    if (args.length < 2 || args.length > 3) return '用法：/model <provider> <model> [effort]'
    const [provider, model, reasoningEffort] = args as [string, string, string?]
    const target = models.groups.find(entry => entry.id === provider)?.models.find(entry => entry.id === model)
    if (target === undefined) return '没有找到该 provider/model；发送 /model 查看可选项。'
    if (reasoningEffort !== undefined && !target.reasoning?.efforts.some(entry => entry.id === reasoningEffort)) return '该模型不支持指定的 effort；发送 /model 查看可选项。'
    const selected = unwrap(await this.api.sessions.selectModel(apiRequest({ sessionId, provider, model,
      ...reasoningEffort === undefined ? {} : { reasoningEffort } }))).selected
    return `已切换到 ${selected.provider} / ${selected.model}，Effort：${selected.reasoningEffort ?? '默认'}。\n${GLOBAL_MODEL_NOTICE}`
  }

  private async effort(sessionId: string, args: readonly string[]): Promise<string> {
    const models = unwrap(await this.api.sessions.models(apiRequest({ sessionId })))
    const efforts = models.groups.find(entry => entry.id === models.current.provider)?.models
      .find(entry => entry.id === models.current.model)?.reasoning?.efforts ?? []
    if (args.length === 0) return `当前 Effort：${models.current.reasoningEffort ?? '默认'}\n可选：${efforts.map(entry => entry.id).join(', ') || '该模型未公开可调 effort'}`
    const [reasoningEffort] = args
    if (args.length !== 1 || reasoningEffort === undefined || !efforts.some(entry => entry.id === reasoningEffort)) return '该模型不支持指定的 effort；发送 /effort 查看可选项。'
    const selected = unwrap(await this.api.sessions.selectModel(apiRequest({ sessionId,
      provider: models.current.provider, model: models.current.model, reasoningEffort }))).selected
    return `Effort 已切换为 ${selected.reasoningEffort ?? reasoningEffort}。\n${GLOBAL_MODEL_NOTICE}`
  }

  private async ensureSession(key: string, requestedSessionId: string): Promise<string> {
    const workspaceId = await this.workspaceIdForSession(requestedSessionId)
      ?? this.runtime.defaultWorkspace.workspaceId
    try {
      await this.createSession(requestedSessionId, workspaceId)
      return requestedSessionId
    } catch (error) {
      if (!(error instanceof HostApiError)
        || (error.code !== 'session-conflict' && error.code !== 'agent-preset-conflict')) throw error
      const replacement = `session-wechat-${randomUUID().replaceAll('-', '')}`
      await this.createSession(replacement, workspaceId)
      await this.runtime.bindings.set(key, replacement)
      this.logger.info('wechat: moved an incompatible conversation to the current channel configuration')
      return replacement
    }
  }

  private async createSession(sessionId: string, workspaceId: string): Promise<void> {
    unwrap(await this.api.sessions.create(apiRequest({ sessionId, workspaceId,
      ...this.agentPreset === undefined ? {} : { agentPreset: this.agentPreset } })))
  }

  private async submitPrompt(
    message: WeChatInboundMessage,
    key: string,
    sessionId: string,
  ): Promise<void> {
    const rpcId = promptRpcIdFor(message)
    const baselineSeq = await this.baselineSeqUnlessDuplicate(sessionId, rpcId)
    if (baselineSeq === undefined) return
    const activeTurn: ActiveTurn = { sessionId, conversationKey: key, userId: message.userId,
      ...message.contextToken === undefined ? {} : { contextToken: message.contextToken } }
    const previousActiveTurn = this.activeTurns.get(sessionId)
    if (previousActiveTurn === undefined) this.activeTurns.set(sessionId, activeTurn)
    const pendingOutcome = this.turnOutcome(sessionId, rpcId, baselineSeq)
    const response = unwrap(await submitChannelPrompt(this.api, apiRequest({
      sessionId,
      mode: previousActiveTurn === undefined ? 'queue' : 'steer',
      content: message.content,
    }, rpcId)))
    if (response.command?.text !== undefined) {
      this.cancelTurnOutcome(pendingOutcome.abort)
      this.activeTurns.delete(sessionId)
      await this.replies.sendText(message.userId, response.command.text, message.contextToken)
      return
    }
    if (response.disposition === 'next-step') {
      this.cancelTurnOutcome(pendingOutcome.abort)
      if (previousActiveTurn === undefined && this.activeTurns.get(sessionId) === activeTurn) {
        this.activeTurns.delete(sessionId)
      }
      await this.replies.sendText(message.userId, CONTINUATION_REPLY, message.contextToken)
      return
    }
    this.activeTurns.set(sessionId, activeTurn)
    this.track(this.observeTurn(activeTurn, pendingOutcome.promise))
  }

  private async baselineSeqUnlessDuplicate(sessionId: string, rpcId: string): Promise<number | undefined> {
    let beforeSeq: number | undefined
    let baseline = -1
    while (true) {
      const history = unwrap(await this.api.sessions.history(apiRequest({
        sessionId,
        maxMessages: HISTORY_PAGE_MESSAGES,
        ...beforeSeq === undefined ? {} : { beforeSeq },
      })))
      baseline = Math.max(baseline, maximumSeq(history.events))
      if (history.events.some(({ event }) => admittedPromptRpcIds(event).includes(rpcId))) return undefined
      if (!history.hasMore || history.events.length === 0) return baseline
      beforeSeq = Math.min(...history.events.map(({ event }) => event.seq))
    }
  }

  private turnOutcome(
    sessionId: string,
    rpcId: string,
    baselineSeq: number,
  ): {
    promise: Promise<{ text: string; images: readonly ImageAttachmentRef[]; reason: unknown }>
    abort: AbortController
  } {
    const projection = new TurnProjection(rpcId)
    const abort = new AbortController()
    this.turnAborts.add(abort)
    let listener: EventListener | undefined
    let timer: ReturnType<typeof setTimeout> | undefined
    const promise = new Promise<{
      text: string; images: readonly ImageAttachmentRef[]; reason: unknown
    }>((resolve, reject) => {
      listener = event => {
        if (event.seq <= baselineSeq) return
        const update = projection.push(event)
        if (update.outcome !== undefined) resolve(update.outcome)
      }
      this.addListener(sessionId, listener)
      timer = setTimeout(() => reject(new Error('wechat: turn observation timed out')), this.config.turnTimeoutMs)
      abort.signal.addEventListener('abort', () => reject(new Error('wechat: turn observation aborted')), { once: true })
    })
    void promise.finally(() => {
      if (timer !== undefined) clearTimeout(timer)
      if (listener !== undefined) this.removeListener(sessionId, listener)
      this.turnAborts.delete(abort)
    }).catch(() => undefined)
    void promise.catch(() => undefined)
    return { promise, abort }
  }

  /**
   * Upload each image and send it as its own iLink message. A failure names the
   * images that stayed behind rather than dropping them silently.
   */
  private async sendImages(
    activeTurn: ActiveTurn,
    images: readonly ImageAttachmentRef[],
  ): Promise<void> {
    if (images.length === 0) return
    const readImage = this.runtime.readImage
    let failed = 0
    for (const ref of images) {
      if (this.stopping) return
      try {
        if (readImage === undefined) throw new Error('this deployment has no attachment store')
        const data = await readImage(ref)
        await this.replies.sendImage(activeTurn.userId, Buffer.from(data), activeTurn.contextToken)
      } catch (error: unknown) {
        failed += 1
        this.logger.error(error)
      }
    }
    if (failed === 0 || this.stopping) return
    await this.replies.sendText(
      activeTurn.userId, undeliveredImageNotice(failed, images.length), activeTurn.contextToken,
    ).catch((error: unknown) => { this.logger.error(error) })
  }

  private async observeTurn(
    activeTurn: ActiveTurn,
    outcome: Promise<{ text: string; images: readonly ImageAttachmentRef[]; reason: unknown }>,
  ): Promise<void> {
    await this.replies.sendText(activeTurn.userId, this.config.thinkingText, activeTurn.contextToken)
    if (this.config.sendTyping) void this.replies.typing(activeTurn.userId, 1, activeTurn.contextToken)
      .catch((error: unknown) => { this.logger.warn(`wechat: typing failed: ${String(error)}`) })
    try {
      const completed = await outcome
      await this.replies.sendText(
        activeTurn.userId,
        finalReply(completed),
        activeTurn.contextToken,
      )
      await this.sendImages(activeTurn, completed.images)
    } finally {
      if (this.config.sendTyping) void this.replies.typing(activeTurn.userId, 2, activeTurn.contextToken)
        .catch((error: unknown) => { this.logger.warn(`wechat: typing cancellation failed: ${String(error)}`) })
      if (this.activeTurns.get(activeTurn.sessionId) === activeTurn) this.activeTurns.delete(activeTurn.sessionId)
    }
  }

  private async answerInteraction(message: WeChatInboundMessage): Promise<boolean> {
    const command = promptText(message)
    if (command === '/approve' || command === '/reject') return await this.answerApproval(message, command)
    if (command === '/answer' || command?.startsWith('/answer ') === true) {
      return await this.answerQuestion(message, command.slice('/answer'.length).trim())
    }
    return false
  }

  private async answerApproval(
    message: WeChatInboundMessage,
    command: '/approve' | '/reject',
  ): Promise<boolean> {
    const conversationKey = conversationKeyFor(message)
    const pending = [...this.pendingApprovals.values()]
      .find(candidate => candidate.activeTurn.conversationKey === conversationKey)
    if (pending === undefined) {
      await this.replies.sendText(message.userId, '当前没有待处理的审批。', message.contextToken)
      return true
    }
    this.removeApproval(pending)
    pending.resolve({
      outcome: command === '/approve' ? 'allowed-once' : 'rejected',
      actorRef: `wechat:${createHash('sha256').update(message.userId).digest('hex')}`,
    })
    await this.replies.sendText(message.userId, command === '/approve' ? '已允许本次操作。' : '已拒绝本次操作。', message.contextToken)
    return true
  }

  private async answerQuestion(message: WeChatInboundMessage, input: string): Promise<boolean> {
    const conversationKey = conversationKeyFor(message)
    const pending = [...this.pendingQuestions.values()]
      .find(candidate => candidate.activeTurn.conversationKey === conversationKey)
    if (pending === undefined) {
      await this.replies.sendText(message.userId, '当前没有待回答的问题。', message.contextToken)
      return true
    }
    const parsed = this.parseQuestionAnswer(pending, input)
    if (typeof parsed === 'string') {
      await this.replies.sendText(message.userId, parsed, message.contextToken)
      return true
    }
    pending.answers.set(parsed.id, parsed)
    const remaining = pending.questions.filter(question => !pending.answers.has(question.id))
    if (remaining.length > 0) {
      await this.replies.sendText(message.userId, `已记录，还需回答：${remaining.map(question => question.id).join('、')}`, message.contextToken)
      return true
    }
    const receipt = await this.api.respond({
      type: 'client-response',
      rpcId: pending.rpcId,
      result: { ok: true, value: { sessionId: pending.activeTurn.sessionId,
        answer: { answers: pending.questions.map(question => pending.answers.get(question.id)!) } } },
    })
    if (!receipt.accepted) this.pendingQuestions.delete(pending.activeTurn.sessionId)
    await this.replies.sendText(message.userId, receipt.accepted ? '答案已提交。' : '这个问题已在其他客户端处理。', message.contextToken)
    return true
  }

  private parseQuestionAnswer(pending: PendingQuestion, input: string): AskUserQuestionAnswerItem | string {
    if (input === '') return '请提供答案。'
    const target = pending.questions.length === 1
      ? { question: pending.questions[0]!, answer: input }
      : this.numberedAnswer(pending.questions, input)
    if (target === undefined) return '多题回答格式：/answer <序号或 id> <答案>。'
    const options = target.question.options ?? []
    if (options.length === 0) return { id: target.question.id, selected: [], custom: target.answer }
    const requested = target.answer.split(',').map(entry => entry.trim()).filter(Boolean)
    const selected = requested.flatMap(entry => {
      const index = Number(entry)
      const option = Number.isInteger(index) && index > 0 ? options[index - 1] : options.find(candidate => candidate.label === entry)
      return option === undefined ? [] : [option.label]
    })
    if (selected.length !== requested.length) return `可选答案：${options.map((option, index) => `${index + 1}. ${option.label}`).join('；')}`
    return { id: target.question.id, selected: target.question.multiSelect === true ? selected : selected.slice(0, 1) }
  }

  private numberedAnswer(
    questions: readonly AskUserQuestionItem[],
    input: string,
  ): { question: AskUserQuestionItem; answer: string } | undefined {
    const separator = input.indexOf(' ')
    if (separator < 1) return undefined
    const selector = input.slice(0, separator)
    const question = questions[Number(selector) - 1] ?? questions.find(candidate => candidate.id === selector)
    return question === undefined ? undefined : { question, answer: input.slice(separator + 1).trim() }
  }

  private formatQuestions(questions: readonly AskUserQuestionItem[]): string {
    return questions.map((question, index) => {
      const options = question.options?.map((option, optionIndex) => `  ${optionIndex + 1}. ${option.label}`).join('\n')
      return `${index + 1}. ${question.question}${options === undefined ? '' : `\n${options}`}`
    }).join('\n')
  }

  private addListener(sessionId: string, listener: EventListener): void {
    const listeners = this.listeners.get(sessionId) ?? new Set<EventListener>()
    listeners.add(listener)
    this.listeners.set(sessionId, listeners)
  }

  private removeListener(sessionId: string, listener: EventListener): void {
    const listeners = this.listeners.get(sessionId)
    listeners?.delete(listener)
    if (listeners?.size === 0) this.listeners.delete(sessionId)
  }

  private cancelTurnOutcome(abort: AbortController): void {
    abort.abort()
  }

  private withdrawApproval(pending: PendingApproval): void {
    if (!this.removeApproval(pending)) return
    pending.resolve(undefined)
  }

  private removeApproval(pending: PendingApproval): boolean {
    const sessionId = pending.activeTurn.sessionId
    if (this.pendingApprovals.get(sessionId) !== pending) return false
    this.pendingApprovals.delete(sessionId)
    if (pending.signal !== undefined && pending.abortListener !== undefined) {
      pending.signal.removeEventListener('abort', pending.abortListener)
    }
    return true
  }
}
