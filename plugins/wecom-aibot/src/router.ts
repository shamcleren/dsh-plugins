import { createHash, randomUUID } from 'node:crypto'
import type { Logger } from '@deepseek-ai/cordis'
import type { ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import type { ApprovalOutcome } from '@deepseek-ai/dsh-user-approval'
import { generateReqId } from '@wecom/aibot-node-sdk'
import type {
  EventMessageWith,
  TemplateCard,
  TemplateCardEventData,
  WsFrame,
  WsFrameHeaders,
} from '@wecom/aibot-node-sdk'
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
  RpcReceipt,
  RpcRequest,
  SessionEventFrame,
} from './host-api.js'
import { HostApiError } from './host-api.js'
import { unwrap, submitChannelPrompt } from './host-api.js'
import {
  conversationKeyFor,
  normalizeTemplateCardClick,
  normalizeTextFrame,
  promptRpcIdFor,
  sessionIdFor,
} from './inbound.js'
import type { WeComInboundText, WeComTextFrame } from './inbound.js'
import {
  admittedPromptRpcIds,
  approvalCommand,
  boundReply,
  fallbackReply,
  TurnProjection,
} from './reply.js'
import type { ConversationBindings } from './bindings.js'
import type { WeComSettingsPatch } from './config.js'

const HISTORY_PAGE_MESSAGES = 100
const MAX_CARD_BUTTONS = 6
const MAX_SETTLED_CARDS = 100
const INTERNAL_ERROR_REPLY = '处理请求时发生错误，请稍后重试。'
const NO_PENDING_APPROVAL_REPLY = '当前没有待处理的审批。'
const APPROVAL_OWNER_REPLY = '只有发起本轮请求的用户可以处理该审批。'
const NO_PENDING_QUESTION_REPLY = '当前没有待回答的问题。'
const QUESTION_OWNER_REPLY = '只有发起本轮请求的用户可以回答该问题。'
const CONTINUATION_REPLY = '已加入当前任务。'

function isAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true
}

/**
 * Images travel as their own WeCom messages after the text, so a turn that
 * produced only images still needs the text reply suppressed rather than filled
 * with the "no text" fallback.
 */
const IMAGE_LEAD_IN = '图片如下：'

function undeliveredImageNotice(failed: number, total: number): string {
  const scope = failed === total ? `本轮生成的 ${total} 张图片` : `其中 ${failed} 张图片`
  return `${scope}未能发送到企微，已保存在 DSH 会话中。`
}

const IMAGE_EXTENSIONS: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
}

/** A display name WeCom accepts, keeping the stored extension meaningful. */
function imageFilename(ref: ImageAttachmentRef, index: number): string {
  const extension = IMAGE_EXTENSIONS[ref.mediaType] ?? 'png'
  const base = ref.name?.replaceAll(/[/\\]/gu, '').trim()
  if (base === undefined || base === '') return `image-${index + 1}.${extension}`
  return /\.[a-z0-9]+$/iu.test(base) ? base : `${base}.${extension}`
}

/**
 * WeCom only sends a plaintext userid when the Bot's creator is a corp super
 * admin; otherwise `from.userid` is the corp-scoped encrypted userid, which no
 * console screen displays. Echoing the received value back to the sender who
 * produced it is the only way a refused user can learn what to put on either
 * list, so every refusal carries it.
 */
function identityHint(userId: string): string {
  return `你的 userid 是：${userId}`
}

function unauthorizedReply(userId: string): string {
  return `你没有权限使用这个机器人。\n${identityHint(userId)}\n请让管理员把它填进「允许的用户 ID」。`
}

function commandPermissionReply(userId: string): string {
  return `只有机器人管理员可以执行该命令。\n${identityHint(userId)}\n请让管理员把它填进「管理员用户 ID」。`
}

function whoamiReply(userId: string): string {
  return `${identityHint(userId)}\n把它填进插件设置的「允许的用户 ID」或「管理员用户 ID」即可授权。`
}

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
  '/whoami - 查看自己的 userid（无需管理员）',
  '/status - 查看当前模型与 effort',
  '/new - 新建并切换会话',
  '/workspace [名称或 ID|reset] - 查看或切换工作区',
  '/preset [<id>|reset] - 查看或切换本渠道的 Agent 预设',
  '/model [provider model [effort]] - 查看或切换模型（会改全局默认）',
  '/effort [level] - 查看或调整推理强度（会改全局默认）',
  '/compact - 压缩当前会话',
  '/answer <答案> - 回答当前交互问题',
].join('\n')

export interface WeComReplyClient {
  replyStream(
    frame: WsFrameHeaders,
    streamId: string,
    content: string,
    finish?: boolean,
  ): Promise<WsFrame>
  replyStreamNonBlocking(
    frame: WsFrameHeaders,
    streamId: string,
    content: string,
    finish?: boolean,
  ): Promise<WsFrame | 'skipped'>
  sendMessage(
    targetId: string,
    body: { msgtype: 'template_card'; template_card: TemplateCard }
      | { msgtype: 'markdown'; markdown: { content: string } },
  ): Promise<WsFrame>
  uploadMedia(
    fileBuffer: Buffer,
    options: { type: 'image'; filename: string },
  ): Promise<{ media_id: string }>
  sendMediaMessage(
    targetId: string,
    mediaType: 'image',
    mediaId: string,
  ): Promise<WsFrame>
  updateTemplateCard(
    frame: WsFrameHeaders,
    templateCard: TemplateCard,
    userids?: string[],
  ): Promise<WsFrame>
}

export type WeComTemplateCardEventFrame = WsFrame<EventMessageWith<TemplateCardEventData>>

export interface RouterConfig {
  allowedUsers: readonly string[]
  adminUsers: readonly string[]
  agentPreset?: string
  thinkingText: string
  turnTimeoutMs: number
}

export interface RouterRuntimeContext {
  bindings: Pick<ConversationBindings, 'current' | 'set'>
  defaultWorkspace: HostWorkspace
  /** Durable image bytes, absent when the deployment has no attachment store. */
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

interface TurnOutcome {
  text: string
  images: readonly ImageAttachmentRef[]
  reason: unknown
}

interface TurnWaitOptions {
  baselineSeq: number
  promptRpcId: string
  activeTurn: ActiveTurn
}

interface SessionState {
  readonly promptRpcIds: Set<string>
  lastSeq: number
}

interface ActiveTurn {
  sessionId: string
  conversationKey: string
  targetId: string
  userId: string
  frame: WsFrameHeaders
  streamId: string
  text: string
  segmentStartText: string
  streamText: string
  awaitingInteraction: boolean
  outputMode: 'stream' | 'proactive'
}

interface PendingApproval {
  id: string
  taskId: string
  activeTurn: ActiveTurn
  resolve: (answer: ChannelApprovalAnswer | undefined) => void
  signal?: AbortSignal
  onAbort?: () => void
  cardHandled?: boolean
  locallyAnswered?: boolean
}

interface PendingQuestion {
  rpcId: string
  taskId: string
  activeTurn: ActiveTurn
  questions: AskUserQuestionItem[]
  answers: Map<string, AskUserQuestionAnswerItem>
  cardPresented?: boolean
  cardHandled?: boolean
  locallyAnswered?: boolean
}

interface ResolvedTemplateCard extends TemplateCard {
  replace_text: string
}

interface SettledCard {
  userId: string
  title: string
}

type SessionListener = (event: HostSessionEvent) => void

function apiRequest<T>(payload: T): RpcRequest<T> {
  return { rpcId: `wecom-api-${randomUUID()}`, payload }
}

function minimumSeq(events: readonly { event: HostSessionEvent }[]): number | undefined {
  let result: number | undefined
  for (const { event } of events) {
    if (result === undefined || event.seq < result) result = event.seq
  }
  return result
}

function maximumSeq(events: readonly { event: HostSessionEvent }[]): number {
  let result = -1
  for (const { event } of events) result = Math.max(result, event.seq)
  return result
}

function managementCommandText(message: WeComInboundText): string | undefined {
  const text = message.text.trim()
  if (text.startsWith('/')) return text
  if (message.chatType !== 'group') return undefined
  return /^@.+?\s+(\/.*)$/u.exec(text)?.[1]?.trim()
}

/** Route WeCom text frames through the Host API and project durable turn output back to WeCom. */
export class WeComConversationRouter {
  private readonly allowedUsers: ReadonlySet<string>
  private readonly adminUsers: ReadonlySet<string>
  private readonly listeners = new Map<string, Set<SessionListener>>()
  private readonly admissions = new Map<string, Promise<void>>()
  private readonly tasks = new Set<Promise<void>>()
  private readonly sessionStates = new Map<string, Promise<SessionState>>()
  private readonly activeTurns = new Map<string, ActiveTurn>()
  private readonly pendingApprovals = new Map<string, PendingApproval>()
  private readonly pendingQuestions = new Map<string, PendingQuestion>()
  private readonly settledCards = new Map<string, SettledCard>()
  private readonly turnAborts = new Set<AbortController>()
  private muxAbort: AbortController | undefined
  private muxTask: Promise<void> | undefined
  private muxFailure: Error | undefined
  private stopping = false
  /** Live channel preset; `/preset` moves it without reopening the socket. */
  private agentPreset: string | undefined

  constructor(
    private readonly api: HostApiProxy,
    private readonly replies: WeComReplyClient,
    private readonly logger: Logger,
    private readonly config: RouterConfig,
    private readonly runtime: RouterRuntimeContext,
    private readonly writeSettings: (section: WeComSettingsPatch) => Promise<void>
      = () => Promise.reject(new Error('this deployment has no writable settings provider')),
  ) {
    this.allowedUsers = new Set(config.allowedUsers)
    this.adminUsers = new Set(config.adminUsers)
    this.agentPreset = config.agentPreset
  }

  /** Adopt a settings-side preset change without disturbing live conversations. */
  setAgentPreset(next: string | undefined): void {
    this.agentPreset = next
  }

  /** Begin the one Host event stream shared by every WeCom conversation. */
  start(): void {
    if (this.muxTask !== undefined) return
    this.stopping = false
    this.muxFailure = undefined
    const abort = new AbortController()
    this.muxAbort = abort
    this.muxTask = this.consumeMux(abort.signal)
  }

  /** Accept one SDK callback without allowing its promise to escape EventEmitter. */
  accept(frame: WeComTextFrame): void {
    if (this.stopping) return
    this.track(this.routeFrame(frame))
  }

  /** Accept one template-card click without allowing its promise to escape EventEmitter. */
  acceptTemplateCardEvent(frame: WeComTemplateCardEventFrame): void {
    if (this.stopping) return
    this.track(this.routeTemplateCardEvent(frame))
  }

  private track(task: Promise<void>): void {
    const tracked = task.catch((error: unknown) => {
      if (!this.stopping) this.logger.error(error)
    })
    this.tasks.add(tracked)
    void tracked.finally(() => { this.tasks.delete(tracked) })
  }

  /** Stop callbacks and the Host stream, then settle every router-owned task. */
  async stop(): Promise<void> {
    if (this.stopping) return
    this.stopping = true
    for (const pending of [...this.pendingApprovals.values()]) {
      this.withdrawApproval(pending)
    }
    this.pendingQuestions.clear()
    this.settledCards.clear()
    for (const abort of this.turnAborts) abort.abort(new Error('wecom-aibot router stopped'))
    this.muxAbort?.abort()
    await this.muxTask
    await Promise.allSettled([...this.tasks])
    this.listeners.clear()
    this.admissions.clear()
    this.sessionStates.clear()
    this.activeTurns.clear()
    this.turnAborts.clear()
    this.muxAbort = undefined
    this.muxTask = undefined
  }

  /** Whether this channel owns the exact live session turn. */
  /** Route questions and events only while this channel owns the active turn. */
  routesSession(sessionId: string): boolean { return this.activeTurns.has(sessionId) }

  /**
   * Whether this channel is waiting on the session's events. This opens when the
   * turn subscribes, which is earlier than `routesSession`: the agent emits
   * `turn/start` and the admitting `user/message` while the prompt submission is
   * still in flight, and those are the only events that attribute a turn to this
   * channel. Dropping them at the source leaves the turn unattributable, so it
   * never completes and can only end by timing out.
   */
  observesSession(sessionId: string): boolean {
    return this.listeners.has(sessionId) || this.activeTurns.has(sessionId)
  }

  ownsSession(sessionId: string): boolean {
    return this.activeTurns.has(sessionId)
  }

  /** Offer one DSH approval only when its agent turn is currently owned by this channel. */
  async requestApproval(request: ChannelApprovalRequest): Promise<ChannelApprovalAnswer | undefined> {
    const activeTurn = this.activeTurns.get(request.sessionId)
    if (activeTurn === undefined || this.pendingApprovals.has(activeTurn.conversationKey)) return undefined
    if (isAborted(request.signal)) return undefined
    const command = request.callId === undefined
      ? undefined
      : await this.findApprovalCommand(activeTurn.sessionId, request.callId)
    if (isAborted(request.signal)) return undefined

    return await new Promise<ChannelApprovalAnswer | undefined>((resolve) => {
      const pending: PendingApproval = {
        id: request.id,
        taskId: `wecom_approval_${randomUUID()}`,
        activeTurn,
        resolve,
        ...request.signal === undefined ? {} : { signal: request.signal },
      }
      if (request.signal !== undefined) {
        pending.onAbort = () => { this.withdrawApproval(pending) }
        request.signal.addEventListener('abort', pending.onAbort, { once: true })
      }
      this.pendingApprovals.set(activeTurn.conversationKey, pending)
      const detail = request.reason === undefined ? '' : `\n原因：${request.reason}`
      const notice = this.withNotice(
        activeTurn,
        `需要你的审批\n工具：${request.toolName}${detail}\n点击卡片按钮，或回复 /approve、/reject。`,
      )
      activeTurn.awaitingInteraction = true
      void this.interactiveUpdate(
        activeTurn,
        notice,
        this.approvalCard(pending, request.toolName, request.reason, command),
      ).catch((error: unknown) => {
        this.logger.error(error)
        this.withdrawApproval(pending)
      })
      void request.resolved.then((resolution) => {
        if (this.activeTurns.get(activeTurn.sessionId) !== activeTurn) return
        if (activeTurn.awaitingInteraction) this.rotateProactive(activeTurn)
        const notice = resolution.outcome === 'allowed-once'
          ? '审批已通过，任务继续执行。'
          : resolution.outcome === 'rejected'
            ? '审批已拒绝。'
            : '审批已结束。'
        if (pending.cardHandled !== true) {
          this.rememberSettledCard(pending.taskId, activeTurn.userId, notice)
        }
        if (pending.locallyAnswered === true) return undefined
        activeTurn.streamText = this.withNotice(activeTurn, notice)
        if (activeTurn.outputMode === 'proactive') return undefined
        return this.reliableUpdate(activeTurn.frame, activeTurn.streamId, activeTurn.streamText)
      }).catch((error: unknown) => { this.logger.warn(`wecom-aibot: approval resolution reply failed: ${String(error)}`) })
    })
  }

  private async consumeMux(signal: AbortSignal): Promise<void> {
    try {
      const stream = this.api.events.mux(apiRequest({}), signal)
      for await (const message of stream) {
        this.consumeMuxFrame(message)
      }
      if (!this.stopping) throw new Error('wecom-aibot: Host event stream ended')
    } catch (error: unknown) {
      if (this.stopping) return
      const failure = error instanceof Error ? error : new Error(String(error))
      this.muxFailure = failure
      for (const listeners of this.listeners.values()) {
        for (const listener of listeners) {
          try {
            listener({ type: 'wecom/mux-error', seq: -1, data: failure })
          } catch (listenerError: unknown) {
            this.logger.error(listenerError)
          }
        }
      }
      this.logger.error(failure)
    }
  }

  private consumeMuxFrame(message: RpcRequest<HostMuxFrame>): void {
    switch (message.payload.type) {
      case 'session/event':
        this.publish(message.payload as SessionEventFrame)
        return
      case 'question/requested':
        this.presentQuestion(message.rpcId, message.payload as QuestionRequestedFrame)
        return
      case 'question/resolved':
        this.resolveQuestion(message.payload as QuestionResolvedFrame)
        return
      default:
        return
    }
  }

  private presentQuestion(rpcId: string, frame: QuestionRequestedFrame): void {
    const activeTurn = this.activeTurns.get(frame.sessionId)
    if (activeTurn === undefined) return
    const current = this.pendingQuestions.get(activeTurn.conversationKey)
    if (current?.rpcId === rpcId) return
    if (current !== undefined) {
      this.logger.warn(`wecom-aibot: ignored concurrent question ${rpcId} for ${frame.sessionId}`)
      return
    }
    const pending: PendingQuestion = {
      rpcId,
      taskId: `wecom_question_${randomUUID()}`,
      activeTurn,
      questions: frame.questions,
      answers: new Map(),
    }
    this.pendingQuestions.set(activeTurn.conversationKey, pending)
    const notice = this.withNotice(activeTurn, this.formatQuestions(frame.questions))
    const card = this.questionCard(pending)
    pending.cardPresented = card !== undefined
    const presentation = card === undefined
      ? this.finish(activeTurn.frame, activeTurn.streamId, notice)
      : this.interactiveUpdate(activeTurn, notice, card)
    activeTurn.awaitingInteraction = true
    void presentation.catch((error: unknown) => {
      this.logger.error(error)
      this.removePendingQuestion(pending)
    })
  }

  private resolveQuestion(frame: QuestionResolvedFrame): void {
    const pending = [...this.pendingQuestions.values()]
      .find(candidate => candidate.rpcId === frame.questionRpcId)
    if (pending === undefined) return
    const notice = frame.outcome === 'answered'
      ? '问题已回答，任务继续执行。'
      : '问题已取消。'
    if (pending.cardPresented === true && pending.cardHandled !== true) {
      this.rememberSettledCard(pending.taskId, pending.activeTurn.userId, notice)
    }
    this.removePendingQuestion(pending)
    if (pending.locallyAnswered === true) return
    if (pending.activeTurn.awaitingInteraction) {
      this.rotateProactive(pending.activeTurn)
    }
    pending.activeTurn.streamText = this.withNotice(pending.activeTurn, notice)
    const resolution = pending.activeTurn.outputMode === 'proactive'
      ? Promise.resolve()
      : this.reliableUpdate(
        pending.activeTurn.frame, pending.activeTurn.streamId, pending.activeTurn.streamText,
      )
    void resolution.catch((error: unknown) => {
      this.logger.warn(`wecom-aibot: question resolution reply failed: ${String(error)}`)
    })
  }

  private publish(frame: SessionEventFrame): void {
    const sessionState = this.sessionStates.get(frame.sessionId)
    if (sessionState !== undefined) {
      void sessionState.then((state) => {
        state.lastSeq = Math.max(state.lastSeq, frame.event.seq)
        for (const rpcId of admittedPromptRpcIds(frame.event)) state.promptRpcIds.add(rpcId)
      }, () => undefined)
    }
    const listeners = this.listeners.get(frame.sessionId)
    if (listeners === undefined) return
    for (const listener of [...listeners]) {
      try {
        listener(frame.event)
      } catch (error: unknown) {
        this.logger.error(error)
      }
    }
  }

  private subscribe(sessionId: string, listener: SessionListener): () => void {
    let listeners = this.listeners.get(sessionId)
    if (listeners === undefined) {
      listeners = new Set()
      this.listeners.set(sessionId, listeners)
    }
    listeners.add(listener)
    return () => {
      listeners?.delete(listener)
      if (listeners?.size === 0) this.listeners.delete(sessionId)
    }
  }

  private async routeFrame(frame: WeComTextFrame): Promise<void> {
    let message: WeComInboundText
    try {
      message = normalizeTextFrame(frame)
    } catch (error: unknown) {
      this.logger.warn(error instanceof Error ? error.message : String(error))
      return
    }
    if (this.allowedUsers.size > 0 && !this.allowedUsers.has(message.userId)) {
      await this.finish(frame, generateReqId('stream'), unauthorizedReply(message.userId))
      return
    }
    const conversationKey = conversationKeyFor(message)
    if (await this.handleApprovalCommand(message, conversationKey, frame)) return
    if (await this.handleQuestionCommand(message, conversationKey, frame)) return
    const previous = this.admissions.get(conversationKey) ?? Promise.resolve()
    const current = previous.catch(() => undefined).then(async () => {
      const sessionId = this.runtime.bindings.current(conversationKey, sessionIdFor(message))
      await this.admitFrame(frame, message, conversationKey, sessionId)
    })
    this.admissions.set(conversationKey, current)
    try {
      await current
    } finally {
      if (this.admissions.get(conversationKey) === current) this.admissions.delete(conversationKey)
    }
  }

  private async routeTemplateCardEvent(frame: WeComTemplateCardEventFrame): Promise<void> {
    const click = normalizeTemplateCardClick(frame)
    if (click === undefined) {
      this.logger.warn('wecom-aibot: ignored malformed template-card event')
      return
    }
    const { taskId, eventKey, userId } = click
    const approval = [...this.pendingApprovals.values()]
      .find(candidate => candidate.taskId === taskId)
    if (approval !== undefined) {
      await this.answerApprovalCard(approval, eventKey, userId, frame)
      return
    }
    const question = [...this.pendingQuestions.values()]
      .find(candidate => candidate.taskId === taskId)
    if (question !== undefined) {
      await this.answerQuestionCard(question, eventKey, userId, frame)
      return
    }
    const settled = this.settledCards.get(taskId)
    if (settled?.userId !== userId) return
    this.settledCards.delete(taskId)
    await this.replies.updateTemplateCard(frame, this.resolvedCard(taskId, settled.title))
  }

  private async answerApprovalCard(
    pending: PendingApproval,
    eventKey: string,
    userId: string,
    frame: WeComTemplateCardEventFrame,
  ): Promise<void> {
    if (pending.activeTurn.userId !== userId) return
    if (eventKey !== 'approval_allow' && eventKey !== 'approval_reject') return
    pending.locallyAnswered = true
    const allowed = eventKey === 'approval_allow'
    this.rotateProactive(pending.activeTurn)
    try {
      await this.replies.updateTemplateCard(frame, this.resolvedCard(
        pending.taskId,
        allowed ? '已允许' : '已拒绝',
        allowed ? '任务继续执行' : '操作已取消',
      ))
      pending.cardHandled = true
    } catch (error: unknown) {
      this.logger.warn(`wecom-aibot: approval card resolution failed: ${String(error)}`)
    }
    this.settleApproval(pending, allowed ? 'allowed-once' : 'rejected', userId)
  }

  private async answerQuestionCard(
    pending: PendingQuestion,
    eventKey: string,
    userId: string,
    frame: WeComTemplateCardEventFrame,
  ): Promise<void> {
    if (pending.activeTurn.userId !== userId) return
    const selection = this.cardSelection(eventKey)
    const questionIndex = this.currentQuestionIndex(pending)
    if (selection === undefined || selection.questionIndex !== questionIndex) return
    const question = pending.questions[questionIndex]
    const option = question?.options?.[selection.optionIndex]
    if (question === undefined || option === undefined) return
    pending.cardHandled = true
    pending.answers.set(question.id, { id: question.id, selected: [option.label] })
    const nextCard = this.questionCard(pending)
    if (nextCard !== undefined) {
      pending.cardHandled = false
      await this.replies.updateTemplateCard(frame, nextCard)
      return
    }
    if (this.currentQuestion(pending) !== undefined) {
      await this.replies.updateTemplateCard(frame, this.resolvedCard(
        pending.taskId,
        '已记录选择，请按消息提示继续回答',
      ))
      return
    }
    pending.locallyAnswered = true
    this.rotateProactive(pending.activeTurn)
    const receipt = await this.respondQuestionAnswers(pending)
    await this.replies.updateTemplateCard(frame, this.resolvedCard(
      pending.taskId,
      receipt.accepted ? `已选择：${option.label}` : '问题已在其他客户端处理',
    ))
  }

  private cardSelection(eventKey: string): { questionIndex: number; optionIndex: number } | undefined {
    const matched = /^question_(\d+)_option_(\d+)$/u.exec(eventKey)
    if (matched === null) return undefined
    return { questionIndex: Number(matched[1]!), optionIndex: Number(matched[2]!) }
  }

  private async admitFrame(
    frame: WeComTextFrame,
    message: WeComInboundText,
    conversationKey: string,
    requestedSessionId: string,
  ): Promise<void> {
    if (this.stopping) return
    const streamId = generateReqId('stream')
    let turn: { outcome: Promise<TurnOutcome>; dispose(): void } | undefined
    let handedOff = false
    try {
      const sessionId = await this.ensureSession(conversationKey, requestedSessionId)
      const directCommand = await this.runManagementCommand(message, conversationKey, sessionId)
      if (directCommand !== undefined) {
        await this.finish(frame, streamId, directCommand)
        return
      }
      const promptRpcId = promptRpcIdFor(message)
      const sessionState = await this.sessionState(sessionId)
      if (sessionState.promptRpcIds.has(promptRpcId)) {
        this.logger.debug('wecom-aibot: ignored duplicate message')
        return
      }
      if (this.muxFailure !== undefined) throw this.muxFailure
      const activeTurn: ActiveTurn = {
        sessionId,
        conversationKey,
        targetId: message.conversationId,
        userId: message.userId,
        frame,
        streamId,
        text: '',
        segmentStartText: '',
        streamText: '',
        awaitingInteraction: false,
        outputMode: 'stream',
      }
      turn = this.waitForTurn({
        baselineSeq: sessionState.lastSeq,
        promptRpcId,
        activeTurn,
      })
      await this.update(frame, streamId, this.config.thinkingText)
      const accepted = unwrap(await submitChannelPrompt(this.api, {
        rpcId: promptRpcId,
        payload: {
          sessionId,
          mode: this.activeTurns.has(sessionId) ? 'steer' : 'queue',
          content: [{ type: 'text', text: message.text }],
        },
      }))
      if (accepted.command !== undefined) {
        sessionState.promptRpcIds.add(promptRpcId)
        turn.dispose()
        await this.finish(frame, streamId, accepted.command.text ?? '命令已执行。')
        return
      }
      sessionState.promptRpcIds.add(promptRpcId)
      if (accepted.disposition === 'next-step') {
        turn.dispose()
        await this.finish(frame, streamId, CONTINUATION_REPLY)
        return
      }
      this.activeTurns.set(sessionId, activeTurn)
      handedOff = true
      this.track(this.completeTurn(activeTurn, turn))
    } catch (error: unknown) {
      this.logger.error(error)
      if (!this.stopping) {
        await this.finish(frame, streamId, INTERNAL_ERROR_REPLY).catch((replyError: unknown) => {
          this.logger.error(replyError)
        })
      }
    } finally {
      if (!handedOff) turn?.dispose()
    }
  }

  private async completeTurn(
    activeTurn: ActiveTurn,
    turn: { outcome: Promise<TurnOutcome>; dispose(): void },
  ): Promise<void> {
    try {
      const outcome = await turn.outcome
      if (this.stopping) return
      const segment = this.segmentText(activeTurn, outcome.text)
      const body = segment || activeTurn.streamText
      // The stream still has to be finished, so an image-only turn needs a lead-in
      // rather than an empty final frame; the images follow as their own messages.
      const textReply = body
        || (outcome.images.length > 0 ? IMAGE_LEAD_IN : fallbackReply(outcome.reason))
      if (activeTurn.outputMode === 'proactive') {
        await this.sendProactiveText(activeTurn, textReply)
      } else {
        await this.finish(activeTurn.frame, activeTurn.streamId, textReply)
      }
      await this.sendImages(activeTurn, outcome.images)
    } catch (error: unknown) {
      this.logger.error(error)
      if (!this.stopping) {
        const failureReply = activeTurn.outputMode === 'proactive'
          ? this.sendProactiveText(activeTurn, INTERNAL_ERROR_REPLY)
          : this.finish(activeTurn.frame, activeTurn.streamId, INTERNAL_ERROR_REPLY)
        await failureReply.catch((replyError: unknown) => { this.logger.error(replyError) })
      }
    } finally {
      turn.dispose()
      if (this.activeTurns.get(activeTurn.sessionId) === activeTurn) {
        this.activeTurns.delete(activeTurn.sessionId)
      }
      const pending = this.pendingApprovals.get(activeTurn.conversationKey)
      if (pending?.activeTurn === activeTurn) this.withdrawApproval(pending)
      const question = this.pendingQuestions.get(activeTurn.conversationKey)
      if (question?.activeTurn === activeTurn) this.removePendingQuestion(question)
    }
  }

  private async handleQuestionCommand(
    message: WeComInboundText,
    conversationKey: string,
    frame: WeComTextFrame,
  ): Promise<boolean> {
    const command = managementCommandText(message)
    if (command !== '/answer' && !command?.startsWith('/answer ')) return false
    const pending = this.pendingQuestions.get(conversationKey)
    if (pending === undefined) {
      await this.finish(frame, generateReqId('stream'), NO_PENDING_QUESTION_REPLY)
      return true
    }
    if (pending.activeTurn.userId !== message.userId) {
      await this.finish(frame, generateReqId('stream'), QUESTION_OWNER_REPLY)
      return true
    }
    await this.acceptQuestionAnswer(pending, command.slice('/answer'.length).trim(), frame)
    return true
  }

  private async acceptQuestionAnswer(
    pending: PendingQuestion,
    input: string,
    frame: WeComTextFrame,
  ): Promise<void> {
    const answer = this.parseQuestionAnswer(pending, input)
    if (typeof answer === 'string') {
      await this.finish(frame, generateReqId('stream'), answer)
      return
    }
    pending.answers.set(answer.id, answer)
    const remaining = pending.questions.filter(question => !pending.answers.has(question.id))
    if (remaining.length === 0) {
      await this.submitQuestionAnswers(pending, frame)
      return
    }
    await this.finish(
      frame,
      generateReqId('stream'),
      `已记录“${answer.id}”。还需回答：${remaining.map(question => question.id).join('、')}。`,
    )
  }

  private async submitQuestionAnswers(
    pending: PendingQuestion,
    frame: WeComTextFrame,
  ): Promise<void> {
    pending.locallyAnswered = true
    this.rotateProactive(pending.activeTurn)
    const receipt = await this.respondQuestionAnswers(pending)
    const acknowledgment = receipt.accepted
      ? '答案已提交，任务继续执行。'
      : '这个问题已经在其他客户端处理。'
    await this.finish(frame, generateReqId('stream'), acknowledgment)
  }

  private async respondQuestionAnswers(pending: PendingQuestion): Promise<RpcReceipt> {
    const answers = pending.questions.map(question => pending.answers.get(question.id)!)
    const receipt = await this.api.respond({
      type: 'client-response',
      rpcId: pending.rpcId,
      result: {
        ok: true,
        value: {
          sessionId: pending.activeTurn.sessionId,
          answer: { answers },
        },
      },
    })
    if (!receipt.accepted) this.removePendingQuestion(pending)
    return receipt
  }

  private parseQuestionAnswer(
    pending: PendingQuestion,
    input: string,
  ): AskUserQuestionAnswerItem | string {
    const target = this.questionTarget(pending, input)
    if (target === undefined) return this.answerUsage(pending)
    const options = target.question.options ?? []
    if (options.length === 0) {
      return { id: target.question.id, selected: [], custom: target.answerText }
    }
    return this.matchQuestionOptions(target.question, target.answerText, pending)
  }

  private questionTarget(
    pending: PendingQuestion,
    input: string,
  ): { question: AskUserQuestionItem; answerText: string } | undefined {
    if (input === '') return undefined
    if (pending.questions.length === 1) {
      return { question: pending.questions[0]!, answerText: input }
    }
    const separator = input.search(/\s/u)
    if (separator < 0) return undefined
    const selector = input.slice(0, separator)
    const answerText = input.slice(separator).trim()
    const number = Number(selector)
    const question = Number.isInteger(number) && number > 0
      ? pending.questions[number - 1]
      : pending.questions.find(candidate => candidate.id === selector)
    return question === undefined || answerText === '' ? undefined : { question, answerText }
  }

  private matchQuestionOptions(
    question: AskUserQuestionItem,
    answerText: string,
    pending: PendingQuestion,
  ): AskUserQuestionAnswerItem | string {
    const options = question.options!
    const selected: string[] = []
    const custom: string[] = []
    for (const token of answerText.split(/[,，]/u).map(part => part.trim()).filter(Boolean)) {
      const number = Number(token)
      const option = Number.isInteger(number) && number > 0
        ? options[number - 1]
        : options.find(candidate => candidate.label === token)
      if (option === undefined) custom.push(token)
      else if (!selected.includes(option.label)) selected.push(option.label)
    }
    if (selected.length === 0 && custom.length === 0) return this.answerUsage(pending)
    if (question.multiSelect !== true && selected.length + (custom.length > 0 ? 1 : 0) > 1) {
      return `“${question.id}”只能选择一个答案。`
    }
    return {
      id: question.id,
      selected,
      ...custom.length === 0 ? {} : { custom: custom.join('，') },
    }
  }

  private answerUsage(pending: PendingQuestion): string {
    return pending.questions.length === 1
      ? '用法：/answer <选项序号、标签或自定义答案>'
      : '用法：/answer <问题序号或 ID> <选项序号、标签或自定义答案>'
  }

  private formatQuestions(questions: readonly AskUserQuestionItem[]): string {
    const rows = questions.flatMap((question, questionIndex) => {
      const title = question.header === undefined
        ? `${questionIndex + 1}. ${question.question}`
        : `${questionIndex + 1}. 【${question.header}】${question.question}`
      const detail = question.detail === undefined ? [] : [question.detail]
      const options = (question.options ?? []).map((option, optionIndex) => {
        const description = option.description === undefined ? '' : ` — ${option.description}`
        return `   ${optionIndex + 1}) ${option.label}${description}`
      })
      const multi = question.multiSelect === true ? ['   可用逗号选择多项。'] : []
      return [title, ...detail, ...options, ...multi]
    })
    const usage = questions.length === 1
      ? '回复 /answer <选项序号、标签或自定义答案>'
      : '逐题回复 /answer <问题序号或 ID> <选项序号、标签或自定义答案>'
    return ['需要你回答问题：', ...rows, usage].join('\n')
  }

  private approvalCard(
    pending: PendingApproval,
    toolName: string,
    reason?: string,
    command?: string,
  ): TemplateCard {
    return {
      card_type: 'button_interaction',
      main_title: { title: '需要审批', desc: this.limitCardText(`工具：${toolName}`, 30) },
      ...reason === undefined ? {} : { sub_title_text: this.limitCardText(reason, 112) },
      ...command === undefined ? {} : {
        quote_area: {
          type: 0,
          title: '执行命令',
          quote_text: command,
        },
      },
      button_list: [
        { text: '允许', key: 'approval_allow', style: 1 },
        { text: '拒绝', key: 'approval_reject', style: 2 },
      ],
      task_id: pending.taskId,
    }
  }

  private questionCard(pending: PendingQuestion): TemplateCard | undefined {
    const questionIndex = this.currentQuestionIndex(pending)
    const question = pending.questions[questionIndex]
    const options = question?.options ?? []
    if (question === undefined || question.multiSelect === true
      || options.length === 0 || options.length > MAX_CARD_BUTTONS) return undefined
    return {
      card_type: 'button_interaction',
      main_title: {
        title: this.limitCardText(question.header ?? '请选择答案', 26),
        desc: this.limitCardText(question.question, 30),
      },
      button_list: options.map((option, index) => ({
        text: this.limitCardText(option.label, 10),
        key: `question_${questionIndex}_option_${index}`,
        style: index === 0 ? 1 : 2,
      })),
      task_id: pending.taskId,
    }
  }

  private currentQuestion(pending: PendingQuestion): AskUserQuestionItem | undefined {
    return pending.questions.find(question => !pending.answers.has(question.id))
  }

  private currentQuestionIndex(pending: PendingQuestion): number {
    return pending.questions.findIndex(question => !pending.answers.has(question.id))
  }

  private resolvedCard(taskId: string, title: string, description?: string): ResolvedTemplateCard {
    return {
      card_type: 'button_interaction',
      main_title: {
        title: this.limitCardText(title, 26),
        ...description === undefined ? {} : { desc: this.limitCardText(description, 30) },
      },
      card_action: { type: 0 },
      button_list: [{ text: '已处理', key: 'resolved_noop', style: 2 }],
      replace_text: '操作成功',
      task_id: taskId,
    }
  }

  private limitCardText(text: string, characters: number): string {
    const content = [...text]
    return content.length <= characters
      ? text
      : `${content.slice(0, characters - 1).join('')}…`
  }

  private rememberSettledCard(taskId: string, userId: string, title: string): void {
    if (this.settledCards.size >= MAX_SETTLED_CARDS) {
      const oldestTaskId = this.settledCards.keys().next().value as string
      this.settledCards.delete(oldestTaskId)
    }
    this.settledCards.set(taskId, { userId, title })
  }

  private async interactiveUpdate(
    activeTurn: ActiveTurn,
    text: string,
    templateCard: TemplateCard,
  ): Promise<WsFrame> {
    const textReply = await this.finish(activeTurn.frame, activeTurn.streamId, text)
    try {
      await this.replies.sendMessage(activeTurn.targetId, {
        msgtype: 'template_card',
        template_card: templateCard,
      })
    } catch (error: unknown) {
      this.logger.warn(`wecom-aibot: proactive template card failed: ${String(error)}`)
    }
    return textReply
  }

  private removePendingQuestion(pending: PendingQuestion): boolean {
    const key = pending.activeTurn.conversationKey
    if (this.pendingQuestions.get(key) !== pending) return false
    this.pendingQuestions.delete(key)
    return true
  }

  private async handleApprovalCommand(
    message: WeComInboundText,
    conversationKey: string,
    frame: WeComTextFrame,
  ): Promise<boolean> {
    const command = managementCommandText(message)
    if (command !== '/approve' && command !== '/reject') return false
    const pending = this.pendingApprovals.get(conversationKey)
    if (pending === undefined) {
      await this.finish(frame, generateReqId('stream'), NO_PENDING_APPROVAL_REPLY)
      return true
    }
    if (pending.activeTurn.userId !== message.userId) {
      await this.finish(frame, generateReqId('stream'), APPROVAL_OWNER_REPLY)
      return true
    }
    const allowed = command === '/approve'
    this.rotateProactive(pending.activeTurn)
    pending.locallyAnswered = true
    const acknowledgment = allowed
      ? '已允许本次操作，任务继续执行。'
      : '已拒绝本次操作。'
    await this.finish(frame, generateReqId('stream'), acknowledgment)
    this.settleApproval(pending, allowed ? 'allowed-once' : 'rejected', message.userId)
    return true
  }

  private settleApproval(
    pending: PendingApproval,
    outcome: ChannelApprovalAnswer['outcome'],
    userId: string,
  ): void {
    if (!this.removePendingApproval(pending)) return
    pending.resolve({ outcome, actorRef: this.actorRef(userId) })
  }

  private withdrawApproval(pending: PendingApproval): void {
    if (!this.removePendingApproval(pending)) return
    pending.resolve(undefined)
  }

  private removePendingApproval(pending: PendingApproval): boolean {
    const key = pending.activeTurn.conversationKey
    if (this.pendingApprovals.get(key) !== pending) return false
    this.pendingApprovals.delete(key)
    if (pending.signal !== undefined && pending.onAbort !== undefined) {
      pending.signal.removeEventListener('abort', pending.onAbort)
    }
    return true
  }

  private actorRef(userId: string): string {
    return `wecom:${createHash('sha256').update(userId).digest('hex')}`
  }

  private withNotice(activeTurn: ActiveTurn, notice: string): string {
    const segment = this.segmentText(activeTurn, activeTurn.text)
    return segment === '' ? notice : `${segment}\n\n${notice}`
  }

  private segmentText(activeTurn: ActiveTurn, fullText: string): string {
    const prefix = activeTurn.segmentStartText
    if (prefix === '') return fullText
    if (!fullText.startsWith(prefix)) return fullText
    return fullText.slice(prefix.length).replace(/^\n\n/u, '')
  }

  private rotateProactive(activeTurn: ActiveTurn): void {
    activeTurn.segmentStartText = activeTurn.text
    activeTurn.streamText = ''
    activeTurn.awaitingInteraction = false
    activeTurn.outputMode = 'proactive'
  }

  private sendProactiveText(activeTurn: ActiveTurn, text: string): Promise<WsFrame> {
    return this.replies.sendMessage(activeTurn.targetId, {
      msgtype: 'markdown',
      markdown: { content: boundReply(text) },
    })
  }

  /**
   * Deliver durable images as their own WeCom messages. Each one is uploaded as
   * temporary media and pushed through the active-send channel, which stays
   * usable after the stream reply has already finished. Anything that cannot be
   * delivered is named in a single notice instead of disappearing.
   */
  private async sendImages(
    activeTurn: ActiveTurn,
    images: readonly ImageAttachmentRef[],
  ): Promise<void> {
    if (images.length === 0) return
    const readImage = this.runtime.readImage
    let failed = 0
    for (const [index, ref] of images.entries()) {
      if (this.stopping) return
      try {
        if (readImage === undefined) throw new Error('this deployment has no attachment store')
        const data = await readImage(ref)
        const media = await this.replies.uploadMedia(Buffer.from(data), {
          type: 'image',
          filename: imageFilename(ref, index),
        })
        await this.replies.sendMediaMessage(activeTurn.targetId, 'image', media.media_id)
      } catch (error: unknown) {
        failed += 1
        this.logger.error(error)
      }
    }
    if (failed === 0 || this.stopping) return
    await this.sendProactiveText(activeTurn, undeliveredImageNotice(failed, images.length))
      .catch((error: unknown) => { this.logger.error(error) })
  }

  private async ensureSession(conversationKey: string, requestedSessionId: string): Promise<string> {
    const workspaceId = await this.workspaceIdForSession(requestedSessionId)
      ?? this.runtime.defaultWorkspace.workspaceId
    try {
      await this.createSession(requestedSessionId, workspaceId)
      return requestedSessionId
    } catch (error: unknown) {
      if (!(error instanceof HostApiError)
        || (error.code !== 'session-conflict' && error.code !== 'agent-preset-conflict')) throw error
      const replacement = `session-wecom-${randomUUID().replaceAll('-', '')}`
      await this.createSession(replacement, workspaceId)
      await this.runtime.bindings.set(conversationKey, replacement)
      this.logger.info('wecom-aibot: moved an incompatible conversation to the current channel configuration')
      return replacement
    }
  }

  private async createSession(sessionId: string, workspaceId: string): Promise<void> {
    unwrap(await this.api.sessions.create(apiRequest({
      sessionId,
      workspaceId,
      ...this.agentPreset === undefined ? {} : { agentPreset: this.agentPreset },
    })))
  }

  private async runManagementCommand(
    message: WeComInboundText,
    conversationKey: string,
    sessionId: string,
  ): Promise<string | undefined> {
    const text = managementCommandText(message)
    if (text === undefined) return undefined
    const [command = '', ...args] = text.split(/\s+/u)
    // Open to everyone: a user locked out by a mistyped list has no other way to
    // read the identity WeCom actually sends for them.
    if (command === '/whoami' && args.length === 0) return whoamiReply(message.userId)
    if (command === '/compact' && args.length === 0) {
      if (!this.adminUsers.has(message.userId)) return commandPermissionReply(message.userId)
      return undefined
    }
    if (!this.adminUsers.has(message.userId)) return commandPermissionReply(message.userId)
    switch (command) {
      case '/help': return COMMAND_HELP
      case '/status': return await this.status(sessionId)
      case '/new': return args.length === 0
        ? await this.newSession(conversationKey, sessionId)
        : '用法：/new'
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

  private async newSession(conversationKey: string, currentSessionId: string): Promise<string> {
    const workspaceId = await this.workspaceIdForSession(currentSessionId)
      ?? this.runtime.defaultWorkspace.workspaceId
    const sessionId = `session-wecom-${randomUUID().replaceAll('-', '')}`
    await this.createSession(sessionId, workspaceId)
    await this.runtime.bindings.set(conversationKey, sessionId)
    return '已创建并切换到新会话（当前工作区）。旧会话仍保留。'
  }

  private async workspace(
    conversationKey: string,
    currentSessionId: string,
    args: readonly string[],
  ): Promise<string> {
    const workspaces = await this.listWorkspaces()
    const current = workspaces.find(entry => entry.sessionIds.includes(currentSessionId))
    if (args.length === 0) {
      const rows = workspaces.map(entry => `${entry.title} (${entry.workspaceId})`)
      return [
        `当前工作区：${current?.title ?? '未分组'}`,
        `默认工作区：${this.runtime.defaultWorkspace.title}`,
        '可选工作区：',
        ...rows,
      ].join('\n')
    }
    const selector = args.join(' ')
    const target = selector === 'reset'
      ? workspaces.find(entry => entry.workspaceId === this.runtime.defaultWorkspace.workspaceId)
      : this.selectWorkspace(workspaces, selector ?? '')
    if (target === undefined) {
      return selector === 'reset'
        ? '默认工作区已不存在，请在插件设置中重新选择。'
        : `没有找到工作区“${selector}”；发送 /workspace 查看可选项。`
    }
    if (target.workspaceId === current?.workspaceId) return `当前已经在工作区“${target.title}”。`
    const sessionId = `session-wecom-${randomUUID().replaceAll('-', '')}`
    await this.createSession(sessionId, target.workspaceId)
    await this.runtime.bindings.set(conversationKey, sessionId)
    return `已切换到工作区“${target.title}”并创建新会话。旧会话仍保留。`
  }

  /**
   * Move the channel's agent preset.
   *
   * Unlike `/model`, this stays inside WeCom: the preset lives in this plugin's
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
    const sessionId = `session-wecom-${randomUUID().replaceAll('-', '')}`
    await this.createSession(sessionId, workspaceId)
    await this.runtime.bindings.set(conversationKey, sessionId)
    return next === undefined
      ? '已恢复跟随全局默认预设，并创建新会话。旧会话仍保留。'
      : `已切换到预设“${next}”，并创建新会话。旧会话仍保留。`
  }

  private selectWorkspace(
    workspaces: readonly HostWorkspace[],
    selector: string,
  ): HostWorkspace | undefined {
    const byId = workspaces.find(entry => entry.workspaceId === selector)
    if (byId !== undefined) return byId
    const byTitle = workspaces.filter(entry => entry.title === selector)
    return byTitle.length === 1 ? byTitle[0] : undefined
  }

  private async workspaceIdForSession(sessionId: string): Promise<string | undefined> {
    return (await this.listWorkspaces())
      .find(workspace => workspace.sessionIds.includes(sessionId))?.workspaceId
  }

  private async listWorkspaces(): Promise<HostWorkspace[]> {
    return unwrap(await this.api.workspace.list(apiRequest({}))).items
  }

  private async model(sessionId: string, args: readonly string[]): Promise<string> {
    const models = unwrap(await this.api.sessions.models(apiRequest({ sessionId })))
    if (args.length === 0) {
      const rows = models.groups.flatMap(group => group.models.map(model => {
        const efforts = model.reasoning?.efforts.map(effort => effort.id).join(', ')
        return `${group.id} ${model.id}${efforts === undefined ? '' : ` [${efforts}]`}`
      }))
      return [`当前：${models.current.provider} ${models.current.model}`, ...rows].join('\n')
    }
    if (args.length < 2 || args.length > 3) return '用法：/model <provider> <model> [effort]'
    const [provider, model, reasoningEffort] = args as [string, string, string?]
    const group = models.groups.find(entry => entry.id === provider)
    const target = group?.models.find(entry => entry.id === model)
    if (target === undefined) return '没有找到该 provider/model；发送 /model 查看可选项。'
    if (reasoningEffort !== undefined
      && !target.reasoning?.efforts.some(entry => entry.id === reasoningEffort)) {
      return '该模型不支持指定的 effort；发送 /model 查看可选项。'
    }
    const selected = unwrap(await this.api.sessions.selectModel(apiRequest({
      sessionId, provider, model,
      ...reasoningEffort === undefined ? {} : { reasoningEffort },
    }))).selected
    return `已切换到 ${selected.provider} / ${selected.model}，Effort：${selected.reasoningEffort ?? '默认'}。\n${GLOBAL_MODEL_NOTICE}`
  }

  private async effort(sessionId: string, args: readonly string[]): Promise<string> {
    const models = unwrap(await this.api.sessions.models(apiRequest({ sessionId })))
    const group = models.groups.find(entry => entry.id === models.current.provider)
    const model = group?.models.find(entry => entry.id === models.current.model)
    const efforts = model?.reasoning?.efforts ?? []
    if (args.length === 0) {
      return `当前 Effort：${models.current.reasoningEffort ?? '默认'}\n可选：${efforts.map(entry => entry.id).join(', ') || '该模型未公开可调 effort'}`
    }
    if (args.length !== 1) return '用法：/effort <level>'
    const [reasoningEffort] = args
    if (reasoningEffort === undefined || !efforts.some(entry => entry.id === reasoningEffort)) {
      return '该模型不支持指定的 effort；发送 /effort 查看可选项。'
    }
    const selected = unwrap(await this.api.sessions.selectModel(apiRequest({
      sessionId,
      provider: models.current.provider,
      model: models.current.model,
      reasoningEffort,
    }))).selected
    return `Effort 已切换为 ${selected.reasoningEffort ?? reasoningEffort}。\n${GLOBAL_MODEL_NOTICE}`
  }

  private sessionState(sessionId: string): Promise<SessionState> {
    const existing = this.sessionStates.get(sessionId)
    if (existing !== undefined) return existing
    const loading = this.loadSessionState(sessionId)
    this.sessionStates.set(sessionId, loading)
    void loading.catch(() => { this.sessionStates.delete(sessionId) })
    return loading
  }

  private async loadSessionState(sessionId: string): Promise<SessionState> {
    let beforeSeq: number | undefined
    let lastSeq = -1
    const promptRpcIds = new Set<string>()
    do {
      const page = unwrap(await this.api.sessions.history(apiRequest({
        sessionId,
        ...beforeSeq === undefined ? {} : { beforeSeq },
        maxMessages: HISTORY_PAGE_MESSAGES,
      })))
      if (beforeSeq === undefined) lastSeq = maximumSeq(page.events)
      for (const { event } of page.events) {
        for (const rpcId of admittedPromptRpcIds(event)) promptRpcIds.add(rpcId)
      }
      if (!page.hasMore) return { promptRpcIds, lastSeq }
      const oldest = minimumSeq(page.events)
      if (oldest === undefined || oldest === 0) return { promptRpcIds, lastSeq }
      beforeSeq = oldest
    } while (true)
  }

  private async findApprovalCommand(sessionId: string, callId: string): Promise<string | undefined> {
    let beforeSeq: number | undefined
    do {
      const page = unwrap(await this.api.sessions.history(apiRequest({
        sessionId,
        ...beforeSeq === undefined ? {} : { beforeSeq },
        maxMessages: HISTORY_PAGE_MESSAGES,
      })))
      for (const { event } of [...page.events].reverse()) {
        const command = approvalCommand(event, callId)
        if (command !== undefined) return command
      }
      if (!page.hasMore) return undefined
      const oldest = minimumSeq(page.events)
      if (oldest === undefined || oldest === 0) return undefined
      beforeSeq = oldest
    } while (true)
  }

  private waitForTurn(options: TurnWaitOptions): { outcome: Promise<TurnOutcome>; dispose(): void } {
    const abort = new AbortController()
    this.turnAborts.add(abort)
    let settled = false
    const projection = new TurnProjection(options.promptRpcId)
    let resolveOutcome: (value: TurnOutcome) => void = () => undefined
    let rejectOutcome: (error: unknown) => void = () => undefined
    const outcome = new Promise<TurnOutcome>((resolve, reject) => {
      resolveOutcome = resolve
      rejectOutcome = reject
    })
    const settle = (result: TurnOutcome | Error): void => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      unsubscribe()
      abort.signal.removeEventListener('abort', onAbort)
      this.turnAborts.delete(abort)
      if (result instanceof Error) rejectOutcome(result)
      else resolveOutcome(result)
    }
    const listener: SessionListener = (event) => {
      if (event.type === 'wecom/mux-error') {
        settle(event.data instanceof Error ? event.data : new Error(String(event.data)))
        return
      }
      if (event.seq <= options.baselineSeq) return
      const update = projection.push(event)
      if (update.partial !== undefined && update.partial !== '') {
        options.activeTurn.text = update.partial
        const segment = this.segmentText(options.activeTurn, update.partial)
        if (segment !== '') {
          options.activeTurn.streamText = segment
          if (options.activeTurn.outputMode === 'stream') {
            void this.update(
              options.activeTurn.frame, options.activeTurn.streamId, segment,
            ).catch((error: unknown) => {
              this.logger.warn(`wecom-aibot: intermediate reply failed: ${String(error)}`)
            })
          }
        }
      }
      if (update.outcome !== undefined) settle(update.outcome)
    }
    const unsubscribe = this.subscribe(options.activeTurn.sessionId, listener)
    const onAbort = (): void => {
      settle(abort.signal.reason instanceof Error ? abort.signal.reason : new Error('aborted'))
    }
    abort.signal.addEventListener('abort', onAbort, { once: true })
    const timeout = setTimeout(() => {
      settle(new Error(`wecom-aibot: turn timed out after ${this.config.turnTimeoutMs}ms`))
    }, this.config.turnTimeoutMs)
    return {
      outcome,
      dispose: () => settle({ text: '', images: [], reason: { kind: 'aborted' } }),
    }
  }

  private update(frame: WsFrameHeaders, streamId: string, text: string): Promise<WsFrame | 'skipped'> {
    return this.replies.replyStreamNonBlocking(frame, streamId, boundReply(text), false)
  }

  private reliableUpdate(frame: WsFrameHeaders, streamId: string, text: string): Promise<WsFrame> {
    return this.replies.replyStream(frame, streamId, boundReply(text), false)
  }

  private finish(frame: WsFrameHeaders, streamId: string, text: string): Promise<WsFrame> {
    return this.replies.replyStream(frame, streamId, boundReply(text), true)
  }
}
