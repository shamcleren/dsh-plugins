import { ensureConversationSession } from '../../core/sessions.js'
import { managementHelp, requiresHostSession, managementFailure } from '../../core/commands.js'
import { displayLabel, runSessionCommand } from '../../core/session-commands.js'
import {
  effortCommand,
  listHostWorkspaces,
  modelCommand,
  newSessionCommand,
  presetCommand,
  selectWorkspace,
  statusCommand,
  type ChannelCommandContext,
} from '../../core/channel-commands.js'
import { createHash, randomUUID } from 'node:crypto'
import type { Logger } from '@deepseek-ai/cordis'
import type { FileAttachmentRef, ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import type { ApprovalOutcome } from '@deepseek-ai/dsh-user-approval'
import type { ConversationBindings } from './bindings.js'
import type {
  AskUserQuestionAnswerItem,
  AskUserQuestionItem,
  HostApiProxy,
  HostMuxFrame,
  HostSessionEvent,
  HostWorkspace,
  QuestionRequestedFrame,
  QuestionResolvedFrame,
  RpcRequest,
} from './host-api.js'
import { unwrap, submitChannelPrompt } from './host-api.js'
import { conversationKeyFor, promptRpcIdFor, sessionIdFor } from './inbound.js'
import type { WeChatInboundMessage } from './inbound.js'
import { admittedPromptRpcIds, TurnProjection } from './reply.js'
import type { TurnOutcome } from './reply.js'
import type { OutboundFileBytes } from './files.js'
import type { WeChatRuntimeConfig, WeChatSettingsPatch } from './config.js'
import { WeChatTyping } from './typing.js'
import { formatWeChatQuestions, parseWeChatQuestionAnswer } from './questions.js'
import {
  finalWeChatReply,
  sendWeChatFiles,
  sendWeChatImages,
  type WeChatMediaDeliveryContext,
} from './outbound-media.js'

const HISTORY_PAGE_MESSAGES = 100
const CONTINUATION_REPLY = '已加入当前任务。'
const COMMAND_PERMISSION_REPLY = '只有机器人管理员可以执行该命令。'
const LOCAL_MODEL_NOTICE = '此选择仅作用于当前微信会话。'
const COMMAND_HELP = managementHelp({ tasks: true, sessions: true })

interface WeChatReplies {
  sendText(userId: string, text: string, contextToken?: string): Promise<void>
  sendImage(userId: string, bytes: Buffer, contextToken?: string): Promise<void>
  sendFile(userId: string, bytes: Buffer, name: string, contextToken?: string): Promise<void>
  sendVideo(userId: string, bytes: Buffer, contextToken?: string): Promise<void>
  typing(userId: string, status: 1 | 2, contextToken?: string, signal?: AbortSignal): Promise<void>
}

export interface RouterRuntimeContext {
  bindings: Pick<ConversationBindings, 'current' | 'set' | 'list'>
  defaultWorkspace: HostWorkspace
  /** Absent on deployments without an attachment store; images then fall back to text. */
  readImage?: (ref: ImageAttachmentRef) => Promise<Uint8Array>
  readFile?: (ref: FileAttachmentRef, signal: AbortSignal) => AsyncIterable<Uint8Array>
  readPresentedFile?: (sessionId: string, path: string, maxBytes: number, signal: AbortSignal) => Promise<OutboundFileBytes>
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
  private deliveryAbort = new AbortController()
  private readonly typing: WeChatTyping
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
    this.typing = new WeChatTyping((userId, status, token, signal) => replies.typing(userId, status, token, signal),
      () => { logger.warn('wechat: typing indicator update failed') })
  }

  /** Adopt a settings-side preset change without disturbing live conversations. */
  setAgentPreset(next: string | undefined): void {
    this.agentPreset = next
  }

  setDefaultWorkspace(workspace: HostWorkspace): void { this.runtime.defaultWorkspace = workspace }

  start(): void {
    if (this.muxTask !== undefined) return
    this.stopping = false
    this.deliveryAbort = new AbortController()
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
    const typingStopped = this.typing.stop()
    this.deliveryAbort.abort()
    for (const sessionId of this.activeTurns.keys()) this.api.releaseSession?.(sessionId)
    for (const pending of this.pendingApprovals.values()) this.withdrawApproval(pending)
    for (const abort of this.turnAborts) abort.abort()
    this.muxAbort?.abort()
    await this.muxTask
    await Promise.allSettled([...this.tasks])
    await typingStopped
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

  private commandContext(): ChannelCommandContext {
    return {
      api: this.api,
      rpcPrefix: 'wechat-api',
      sessionPrefix: 'session-wechat',
      localModelNotice: LOCAL_MODEL_NOTICE,
      defaultWorkspace: () => this.runtime.defaultWorkspace,
      getAgentPreset: () => this.agentPreset,
      setAgentPreset: next => { this.agentPreset = next },
      writeAgentPreset: next => this.writeSettings({ agentPreset: next }),
      createSession: (sessionId, workspaceId) => this.createSession(sessionId, workspaceId),
      bindSession: (key, sessionId, previous) => this.runtime.bindings.set(key, sessionId, previous),
    }
  }

  private mediaContext(): WeChatMediaDeliveryContext {
    return {
      logger: this.logger,
      mediaMaxBytes: this.config.mediaMaxBytes,
      isStopping: () => this.stopping,
      signal: () => this.deliveryAbort.signal,
      ...(this.runtime.readImage === undefined ? {} : { readImage: this.runtime.readImage }),
      ...(this.runtime.readFile === undefined ? {} : { readFile: this.runtime.readFile }),
      ...(this.runtime.readPresentedFile === undefined ? {} : { readPresentedFile: this.runtime.readPresentedFile }),
      sendText: (userId, text, token) => this.replies.sendText(userId, text, token),
      sendImage: (userId, bytes, token) => this.replies.sendImage(userId, bytes, token),
      sendFile: (userId, bytes, name, token) => this.replies.sendFile(userId, bytes, name, token),
      sendVideo: (userId, bytes, token) => this.replies.sendVideo(userId, bytes, token),
    }
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
      `${formatWeChatQuestions(frame.questions)}\n回复 /answer <答案>；多题使用 /answer <序号或 id> <答案>。`,
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
    this.typing.update(key, message.contextToken)
    if (await this.answerInteraction(message)) return
    const requested = this.runtime.bindings.current(key, sessionIdFor(message))
    const text = promptText(message)
    let sessionId = requested, commandReply: string | undefined
    try {
      if (requiresHostSession(text, this.adminUsers.has(message.userId))) sessionId = await this.ensureSession(key, requested)
      commandReply = await this.runManagementCommand(message, key, sessionId)
    } catch (error) {
      if (text === undefined) throw error
      this.logger.warn('im: WeChat management command failed; connection and conversation state retained')
      commandReply = managementFailure()
    }
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
    const cmdCtx = this.commandContext()
    switch (command) {
      case '/help': return COMMAND_HELP
      case '/status': return await statusCommand(cmdCtx, sessionId)
      case '/tasks': return args.length === 0 ? this.taskStatus(conversationKey) : '用法：/tasks'
      case '/cancel': return await this.cancelTask(conversationKey, sessionId, args)
      case '/new': return args.length === 0
        ? await newSessionCommand(cmdCtx, conversationKey, sessionId, '已创建并切换到新会话（当前工作区）。发送 /session 可按标题切回历史会话。')
        : '用法：/new'
      case '/session': return await runSessionCommand({
        sessions: this.api.sessions,
        bindings: this.runtime.bindings,
        key: conversationKey,
        currentSessionId: sessionId,
        args,
        titlePrefix: '【微信】',
      })
      case '/workspace': return await this.workspace(conversationKey, sessionId, args)
      case '/preset': return await presetCommand(cmdCtx, conversationKey, sessionId, args)
      case '/model': return await modelCommand(cmdCtx, sessionId, args)
      case '/effort': return await effortCommand(cmdCtx, sessionId, args)
      default: return `未知命令：${command}\n\n${COMMAND_HELP}`
    }
  }

  private taskStatus(key: string): string {
    const tasks = [...this.activeTurns.values()].filter(turn => turn.conversationKey === key)
    if (tasks.length === 0) return '当前聊天没有活动任务。'
    return ['当前聊天的活动任务：', ...tasks.map(turn => {
      const phase = this.pendingApprovals.has(turn.sessionId) ? '等待审批' : this.pendingQuestions.has(turn.sessionId) ? '等待回答' : '执行中'
      return `${turn.sessionId}：${phase}`
    })].join('\n')
  }

  private async cancelTask(key: string, currentSessionId: string, args: readonly string[]): Promise<string> {
    if (args.length > 1) return '用法：/cancel [会话 ID]'
    const sessionId = args[0] ?? currentSessionId
    const task = this.activeTurns.get(sessionId)
    if (!task || task.conversationKey !== key) return '当前聊天中没有这个活动任务。'
    unwrap(await this.api.sessions.cancel(apiRequest({ sessionId })))
    return '已请求取消任务；最终状态以任务结束消息为准。'
  }

  private async workspace(key: string, currentSessionId: string, args: readonly string[]): Promise<string> {
    const workspaces = await listHostWorkspaces(this.api, 'wechat-api')
    const current = workspaces.find(entry => entry.sessionIds.includes(currentSessionId))
    if (args.length === 0) {
      const defaultWorkspace = workspaces.find(entry => entry.workspaceId === this.runtime.defaultWorkspace.workspaceId)
        ?? this.runtime.defaultWorkspace
      const currentLine = `当前工作区：${displayLabel(current?.title, '未分组')}`
      const summary = current?.workspaceId === defaultWorkspace.workspaceId
        ? `${currentLine}（默认）` : `${currentLine}；默认：${displayLabel(defaultWorkspace.title, '未分组')}`
      const labels = workspaces.map(entry => displayLabel(entry.title, '未命名工作区'))
      const rows = workspaces.map((entry, index) => {
        const label = labels[index]!
        const ambiguous = labels.filter(value => value === label).length > 1 || entry.title.trim().replace(/\s+/gu, ' ') !== entry.title || [...entry.title].length > 60
        const marks = [entry.workspaceId === current?.workspaceId ? '当前' : '', entry.workspaceId === defaultWorkspace.workspaceId ? '默认' : ''].filter(Boolean)
        return `- ${label}${marks.length ? `（${marks.join(' · ')}）` : ''}${ambiguous ? ` · ID：${entry.workspaceId}` : ''}`
      })
      return [`${summary}。可选工作区（/workspace <名称> 切换；/workspace reset 恢复默认）：`,
        rows.join('\n') || '（暂无）'].join('\n')
    }
    const selector = args.join(' ')
    const target = selector === 'reset'
      ? workspaces.find(entry => entry.workspaceId === this.runtime.defaultWorkspace.workspaceId)
      : selectWorkspace(workspaces, selector)
    if (target === undefined) return `没有找到工作区“${selector}”；发送 /workspace 查看可选项。`
    if (target.workspaceId === current?.workspaceId) return `当前已经在工作区“${target.title}”。`
    const sessionId = await this.createSession(`session-wechat-${randomUUID().replaceAll('-', '')}`, target.workspaceId)
    await this.runtime.bindings.set(key, sessionId, current === undefined ? undefined : currentSessionId)
    return `已切换到工作区“${target.title}”并创建新会话。旧会话仍保留。`
  }

  private async ensureSession(key: string, requested: string): Promise<string> {
    const actual = await ensureConversationSession({
      api: this.api,
      key,
      requested,
      defaultWorkspaceId: this.runtime.defaultWorkspace.workspaceId,
      bindings: this.runtime.bindings,
      create: (id, workspace) => this.createSession(id, workspace),
    })
    await this.runtime.bindings.set(key, actual)
    return actual
  }

  private async createSession(sessionId: string, workspaceId: string): Promise<string> {
    return unwrap(await this.api.sessions.create(apiRequest({
      sessionId,
      workspaceId,
      ...this.agentPreset === undefined ? {} : { agentPreset: this.agentPreset },
    }))).sessionId
  }

  private async submitPrompt(
    message: WeChatInboundMessage,
    key: string,
    sessionId: string,
  ): Promise<void> {
    const rpcId = promptRpcIdFor(message)
    const baselineSeq = await this.baselineSeqUnlessDuplicate(sessionId, rpcId)
    if (baselineSeq === undefined) return
    const activeTurn: ActiveTurn = {
      sessionId,
      conversationKey: key,
      userId: message.userId,
      ...message.contextToken === undefined ? {} : { contextToken: message.contextToken },
    }
    const previousActiveTurn = this.activeTurns.get(sessionId)
    if (previousActiveTurn === undefined) this.activeTurns.set(sessionId, activeTurn)
    const pendingOutcome = this.turnOutcome(sessionId, rpcId, baselineSeq)
    let response
    try {
      response = unwrap(await submitChannelPrompt(this.api, apiRequest({
        sessionId,
        mode: previousActiveTurn === undefined ? 'queue' : 'steer',
        content: message.content,
      }, rpcId)))
    } catch (error) {
      this.cancelTurnOutcome(pendingOutcome.abort)
      if (previousActiveTurn === undefined && this.activeTurns.get(sessionId) === activeTurn) this.activeTurns.delete(sessionId)
      throw error
    }
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
    this.track(this.observeTurn(activeTurn, pendingOutcome.promise).finally(() => this.cancelTurnOutcome(pendingOutcome.abort)))
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
    promise: Promise<TurnOutcome>
    abort: AbortController
  } {
    const projection = new TurnProjection(rpcId)
    const abort = new AbortController()
    this.turnAborts.add(abort)
    let listener: EventListener | undefined
    let timer: ReturnType<typeof setTimeout> | undefined
    let follower: Promise<void> | undefined
    const promise = new Promise<TurnOutcome>((resolve, reject) => {
      listener = event => {
        if (event.seq <= baselineSeq) return
        const update = projection.push(event)
        // Admission is bounded; an executing turn belongs to its journal until
        // completion or disposal, including long tools and approval waits.
        if (projection.hasStarted && timer !== undefined) {
          clearTimeout(timer)
          timer = undefined
        }
        if (update.outcome !== undefined) resolve(update.outcome)
      }
      const follow = this.api.sessions.follow?.bind(this.api.sessions)
      if (follow === undefined) this.addListener(sessionId, listener)
      else {
        const receive = listener
        follower = (async () => {
          try {
            for await (const event of follow(apiRequest({ sessionId, afterSeq: baselineSeq }), abort.signal)) receive(event)
            if (!abort.signal.aborted) reject(new Error('wechat: Session journal ended before turn completion'))
          } catch (error) {
            if (!abort.signal.aborted) reject(error)
          }
        })()
      }
      timer = setTimeout(() => reject(new Error('wechat: turn did not start in time')), this.config.turnTimeoutMs)
      abort.signal.addEventListener('abort', () => reject(new Error('wechat: turn observation aborted')), { once: true })
    })
    const settled = promise.finally(async () => {
      if (timer !== undefined) clearTimeout(timer)
      if (listener !== undefined) this.removeListener(sessionId, listener)
      abort.abort()
      await follower
      this.turnAborts.delete(abort)
    })
    void settled.catch(() => undefined)
    return { promise: settled, abort }
  }

  private async observeTurn(
    activeTurn: ActiveTurn,
    outcome: Promise<TurnOutcome>,
  ): Promise<void> {
    const stopTyping = this.config.sendTyping
      ? this.typing.acquire(activeTurn.conversationKey, activeTurn.userId, activeTurn.contextToken)
      : async () => undefined
    try {
      let completed: TurnOutcome
      try { completed = await outcome }
      catch {
        if (this.stopping) return
        this.logger.warn('wechat: turn reply observation failed')
        await this.replies.sendText(activeTurn.userId,
          '本轮回复未能取回，请在 DSH 会话中查看结果，或稍后重试。', activeTurn.contextToken)
        return
      }
      await this.replies.sendText(
        activeTurn.userId,
        finalWeChatReply(completed),
        activeTurn.contextToken,
      )
      const media = this.mediaContext()
      await sendWeChatImages(media, activeTurn, completed.images)
      await sendWeChatFiles(media, activeTurn, completed.files)
    } finally {
      await stopTyping()
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
    const parsed = parseWeChatQuestionAnswer(pending.questions, input)
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
      result: {
        ok: true,
        value: {
          sessionId: pending.activeTurn.sessionId,
          answer: { answers: pending.questions.map(question => pending.answers.get(question.id)!) },
        },
      },
    })
    if (!receipt.accepted) this.pendingQuestions.delete(pending.activeTurn.sessionId)
    await this.replies.sendText(message.userId, receipt.accepted ? '答案已提交。' : '这个问题已在其他客户端处理。', message.contextToken)
    return true
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
