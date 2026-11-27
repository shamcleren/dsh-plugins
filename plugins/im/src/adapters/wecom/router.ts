import { groupName } from '../../contracts.js'
import type { WeComSessionSources } from './session-source.js'
import { ensureConversationSession } from '../../core/sessions.js'
import { managementHelp, requiresHostSession, managementFailure } from '../../core/commands.js'
import { runSessionCommand } from '../../core/session-commands.js'
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
  HostSessionEvent,
  HostWorkspace,
  QuestionRequestedFrame,
  QuestionResolvedFrame,
  RpcReceipt,
  RpcRequest,
  SessionEventFrame,
} from './host-api.js'
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
  MAX_STREAM_REPLY_BYTES,
  splitReply,
  TurnProjection,
} from './reply.js'
import type { TurnOutcome } from './reply.js'
import { inboundContent, type QuestionNames } from './media.js'
import type { OutboundFileBytes } from './files.js'
import type { ConversationBindings } from './bindings.js'
import type { BotModel, WeComSettingsPatch } from './config.js'
import {
  buildApprovalCard,
  buildQuestionCard,
  buildResolvedCard,
  parseCardSelection,
  SettledCardStore,
} from './cards.js'
import {
  currentQuestionIndex,
  formatWeComQuestions,
  parseWeComQuestionAnswer,
} from './questions.js'
import {
  IMAGE_LEAD_IN,
  sendWeComFiles,
  sendWeComImages,
  type WeComMediaDeliveryContext,
} from './outbound-media.js'

const HISTORY_PAGE_MESSAGES = 100
const MAX_FINAL_OBSERVATION_MS = 60 * 60 * 1000
const MAX_MARKDOWN_BYTES = 4096
const INTERNAL_ERROR_REPLY = '处理请求时发生错误，请稍后重试。'
const NO_PENDING_APPROVAL_REPLY = '当前没有待处理的审批。'
const APPROVAL_OWNER_REPLY = '只有发起本轮请求的用户可以处理该审批。'
const NO_PENDING_QUESTION_REPLY = '当前没有待回答的问题。'
const QUESTION_OWNER_REPLY = '只有发起本轮请求的用户可以回答该问题。'
const CONTINUATION_REPLY = '已加入当前任务。'
const LOCAL_MODEL_NOTICE = '此选择仅作用于当前企微会话。'
const COMMAND_HELP = managementHelp({ identity: true, sessions: true })
  + '\n- /groupname <群名>：设置工作台显示的本群名称\n- /myname <姓名>：设置自己提问时的显示名'

function isAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true
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

class TurnObservationTimeout extends Error {}

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
    options: { type: 'image' | 'file' | 'video'; filename: string },
  ): Promise<{ media_id: string }>
  sendMediaMessage(
    targetId: string,
    mediaType: 'image' | 'file' | 'video',
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
  model?: BotModel
  mediaMaxBytes?: number
  allowedUsers: readonly string[]
  adminUsers: readonly string[]
  agentPreset?: string
  rolePrompt?: string
  finalReplyOnly?: boolean
  thinkingText: string
  turnTimeoutMs: number
}

export interface RouterRuntimeContext {
  bindings: Pick<ConversationBindings, 'current' | 'list' | 'set'>
  questionNames?: (message: WeComInboundText) => Promise<QuestionNames>
  sources?: Pick<WeComSessionSources, 'nameSelf' | 'nameGroup'>
  defaultWorkspace: HostWorkspace
  /** Durable image bytes, absent when the deployment has no attachment store. */
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
  private readonly settledCards = new SettledCardStore()
  private readonly turnAborts = new Set<AbortController>()
  private muxAbort: AbortController | undefined
  private muxTask: Promise<void> | undefined
  private muxFailure: Error | undefined
  private stopping = false
  private deliveryAbort = new AbortController()
  /** Live channel preset; `/preset` moves it without reopening the socket. */
  private agentPreset: string | undefined
  private rolePrompt: string | undefined

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
    this.rolePrompt = config.rolePrompt
  }

  /** Adopt a settings-side preset change without disturbing live conversations. */
  setAgentPreset(next: string | undefined): void {
    this.agentPreset = next
  }

  setRolePrompt(next: string | undefined): void { this.rolePrompt = next }

  rolePromptForSession(sessionId: string): string | undefined {
    return this.observesSession(sessionId) ? this.rolePrompt : undefined
  }

  setDefaultWorkspace(workspace: HostWorkspace): void { this.runtime.defaultWorkspace = workspace }

  /** Begin the one Host event stream shared by every WeCom conversation. */
  start(): void {
    if (this.muxTask !== undefined) return
    this.stopping = false
    this.deliveryAbort = new AbortController()
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
    this.deliveryAbort.abort()
    for (const pending of [...this.pendingApprovals.values()]) {
      this.withdrawApproval(pending)
    }
    // A claimed question can still be queued in the mux or fail presentation.
    const sessions = new Set([...this.activeTurns.keys(), ...[...this.pendingQuestions.values()].map(pending => pending.activeTurn.sessionId)])
    for (const sessionId of sessions) this.api.releaseSession?.(sessionId)
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

  /** Route questions and events only while this channel owns the active turn. */
  routesSession(sessionId: string): boolean { return this.activeTurns.has(sessionId) }

  /**
   * Whether this channel is waiting on the session's events. This opens when the
   * turn subscribes, which is earlier than `routesSession`: the agent emits
   * `turn/start` and the admitting `user/message` while the prompt submission is
   * still in flight, and those are the only events that attribute a turn to this
   * channel.
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
        buildApprovalCard(pending.taskId, request.toolName, request.reason, command),
      ).catch((error: unknown) => {
        this.logger.error(error)
        this.withdrawApproval(pending)
      })
      void request.resolved.then((resolution) => {
        if (this.activeTurns.get(activeTurn.sessionId) !== activeTurn) return
        if (activeTurn.awaitingInteraction) this.rotateProactive(activeTurn)
        const settledNotice = resolution.outcome === 'allowed-once'
          ? '审批已通过，任务继续执行。'
          : resolution.outcome === 'rejected'
            ? '审批已拒绝。'
            : '审批已结束。'
        if (pending.cardHandled !== true) {
          this.settledCards.remember(pending.taskId, activeTurn.userId, settledNotice)
        }
        if (pending.locallyAnswered === true) return undefined
        activeTurn.streamText = this.withNotice(activeTurn, settledNotice)
        if (activeTurn.outputMode === 'proactive') return undefined
        return this.reliableUpdate(activeTurn.frame, activeTurn.streamId, activeTurn.streamText)
      }).catch((error: unknown) => { this.logger.warn(`wecom-aibot: approval resolution reply failed: ${String(error)}`) })
    })
  }

  private commandContext(): ChannelCommandContext {
    return {
      api: this.api,
      rpcPrefix: 'wecom-api',
      sessionPrefix: 'session-wecom',
      localModelNotice: LOCAL_MODEL_NOTICE,
      defaultWorkspace: () => this.runtime.defaultWorkspace,
      getAgentPreset: () => this.agentPreset,
      setAgentPreset: next => { this.agentPreset = next },
      writeAgentPreset: next => this.writeSettings({ agentPreset: next }),
      createSession: (sessionId, workspaceId) => this.createSession(sessionId, workspaceId),
      bindSession: (key, sessionId, previous) => this.runtime.bindings.set(key, sessionId, previous),
    }
  }

  private mediaContext(): WeComMediaDeliveryContext {
    return {
      logger: this.logger,
      mediaMaxBytes: this.config.mediaMaxBytes ?? 10 * 1024 * 1024,
      isStopping: () => this.stopping,
      signal: () => this.deliveryAbort.signal,
      ...(this.runtime.readImage === undefined ? {} : { readImage: this.runtime.readImage }),
      ...(this.runtime.readFile === undefined ? {} : { readFile: this.runtime.readFile }),
      ...(this.runtime.readPresentedFile === undefined ? {} : { readPresentedFile: this.runtime.readPresentedFile }),
      uploadMedia: (fileBuffer, options) => this.replies.uploadMedia(fileBuffer, options),
      sendMediaMessage: (targetId, mediaType, mediaId) => this.replies.sendMediaMessage(targetId, mediaType, mediaId),
      sendNotice: (targetId, text) => this.replies.sendMessage(targetId, { msgtype: 'markdown', markdown: { content: boundReply(text) } }),
    }
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
    activeTurn.awaitingInteraction = true
    this.track(this.deliverQuestion(pending).catch((error: unknown) => {
      if (this.removePendingQuestion(pending)) this.api.releaseSession?.(activeTurn.sessionId)
      throw error
    }))
  }

  private async deliverQuestion(pending: PendingQuestion): Promise<void> {
    const { activeTurn } = pending
    const { outputMode } = activeTurn
    const notice = formatWeComQuestions(pending.questions)
    const combined = this.withNotice(activeTurn, notice)
    const fitsStream = Buffer.byteLength(combined) <= MAX_STREAM_REPLY_BYTES
    const stillPending = () => !this.stopping && !pending.locallyAnswered
      && this.pendingQuestions.get(activeTurn.conversationKey) === pending
    if (outputMode === 'stream' && fitsStream) {
      await this.finish(activeTurn.frame, activeTurn.streamId, combined)
    } else {
      if (outputMode === 'stream') {
        const hint = '问题较长，接下来的消息会列出题目和回复方式。'
        const earlier = boundReply(this.segmentText(activeTurn, activeTurn.text), MAX_STREAM_REPLY_BYTES - Buffer.byteLength(hint) - 2)
        await this.finish(activeTurn.frame, activeTurn.streamId, [earlier, hint].filter(Boolean).join('\n\n'))
      }
      for (const part of splitReply(outputMode === 'proactive' ? combined : notice, MAX_MARKDOWN_BYTES)) {
        if (!stillPending()) return
        await this.sendProactiveText(activeTurn, part)
      }
    }
    if (!fitsStream || !stillPending()) return
    const card = buildQuestionCard(pending.taskId, pending.questions, pending.answers)
    if (card !== undefined) {
      pending.cardPresented = true
      await this.sendTemplateCard(activeTurn, card)
    }
  }

  private resolveQuestion(frame: QuestionResolvedFrame): void {
    const pending = [...this.pendingQuestions.values()]
      .find(candidate => candidate.rpcId === frame.questionRpcId)
    if (pending === undefined) return
    const notice = frame.outcome === 'answered'
      ? '问题已回答，任务继续执行。'
      : '问题已取消。'
    if (pending.cardPresented === true && pending.cardHandled !== true) {
      this.settledCards.remember(pending.taskId, pending.activeTurn.userId, notice)
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
    const settled = this.settledCards.take(taskId, userId)
    if (settled === undefined) return
    await this.replies.updateTemplateCard(frame, buildResolvedCard(taskId, settled.title))
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
      await this.replies.updateTemplateCard(frame, buildResolvedCard(
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
    if (pending.activeTurn.userId !== userId || !pending.cardPresented || pending.cardHandled || pending.locallyAnswered) return
    const selection = parseCardSelection(eventKey)
    const questionIndex = currentQuestionIndex(pending.questions, pending.answers)
    if (selection === undefined || selection.questionIndex !== questionIndex) return
    const question = pending.questions[questionIndex]
    const option = question?.options?.[selection.optionIndex]
    if (question === undefined || option === undefined) return
    pending.cardHandled = true
    pending.answers.set(question.id, { id: question.id, selected: [option.label] })
    const nextCard = buildQuestionCard(pending.taskId, pending.questions, pending.answers)
    if (nextCard !== undefined) {
      pending.cardHandled = false
      await this.replies.updateTemplateCard(frame, nextCard)
      return
    }
    const nextQuestion = currentQuestionIndex(pending.questions, pending.answers)
    if (nextQuestion >= 0) {
      await this.replies.updateTemplateCard(frame, buildResolvedCard(
        pending.taskId,
        '已记录选择，请按消息提示继续回答',
        `回复 /answer ${nextQuestion + 1} <答案>`,
      ))
      return
    }
    pending.locallyAnswered = true
    this.rotateProactive(pending.activeTurn)
    const receipt = await this.respondQuestionAnswers(pending)
    await this.replies.updateTemplateCard(frame, buildResolvedCard(
      pending.taskId,
      receipt.accepted ? `已选择：${option.label}` : '问题已在其他客户端处理',
    ))
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
      const sessionId = requiresHostSession(managementCommandText(message), this.adminUsers.has(message.userId))
        ? await this.ensureSession(conversationKey, requestedSessionId) : requestedSessionId
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
        outputMode: this.config.finalReplyOnly ? 'proactive' : 'stream',
      }
      turn = this.waitForTurn({
        baselineSeq: sessionState.lastSeq,
        promptRpcId,
        activeTurn,
      })
      await this.update(frame, streamId, this.config.thinkingText)
      const names = managementCommandText(message) === undefined
        ? await this.runtime.questionNames?.(message).catch(() => { this.logger.warn('wecom-aibot: question display names unavailable') }) ?? {}
        : undefined
      const accepted = unwrap(await submitChannelPrompt(this.api, {
        rpcId: promptRpcId,
        payload: {
          sessionId,
          mode: this.activeTurns.has(sessionId) ? 'steer' : 'queue',
          content: await inboundContent(message, this.config.mediaMaxBytes ?? 10 * 1024 * 1024, this.deliveryAbort.signal, names),
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
      if (this.config.finalReplyOnly) {
        await this.finish(frame, streamId, '收到，处理完会在这里回复。').catch(() => this.logger.warn('wecom-aibot: acknowledgement delivery failed'))
      }
      handedOff = true
      this.track(this.completeTurn(activeTurn, turn))
    } catch (error: unknown) {
      this.logger.error(error)
      if (!this.stopping) {
        await this.finish(frame, streamId, managementCommandText(message) === undefined ? INTERNAL_ERROR_REPLY : managementFailure()).catch((replyError: unknown) => {
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
      const body = this.config.finalReplyOnly ? outcome.text : segment || activeTurn.streamText
      // The stream still has to be finished, so an image-only turn needs a lead-in
      // rather than an empty final frame; the images follow as their own messages.
      const textReply = body
        || (outcome.files.length > 0 ? '附件如下：' : outcome.images.length > 0 ? IMAGE_LEAD_IN : fallbackReply(outcome.reason))
      if (activeTurn.outputMode === 'proactive') {
        for (const part of splitReply(textReply, MAX_MARKDOWN_BYTES)) await this.sendProactiveText(activeTurn, part)
      } else {
        await this.finish(activeTurn.frame, activeTurn.streamId, textReply)
      }
      const media = this.mediaContext()
      await sendWeComImages(media, activeTurn.targetId, outcome.images)
      await sendWeComFiles(media, activeTurn.sessionId, activeTurn.targetId, outcome.files)
    } catch (error: unknown) {
      this.logger.error(error)
      if (!this.stopping) {
        const notice = error instanceof TurnObservationTimeout
          ? '等待结果已超时，可在 DSH 会话中查看后续进度。' : INTERNAL_ERROR_REPLY
        const failureReply = activeTurn.outputMode === 'proactive'
          ? this.sendProactiveText(activeTurn, notice)
          : this.finish(activeTurn.frame, activeTurn.streamId, notice)
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
    const answer = parseWeComQuestionAnswer(pending.questions, input)
    if (typeof answer === 'string') {
      await this.finish(frame, generateReqId('stream'), answer)
      return
    }
    pending.answers.set(answer.id, answer)
    const nextQuestion = currentQuestionIndex(pending.questions, pending.answers)
    if (nextQuestion < 0) {
      await this.submitQuestionAnswers(pending, frame)
      return
    }
    await this.finish(
      frame,
      generateReqId('stream'),
      `已记录。下一题可回复 \`/answer ${nextQuestion + 1} <答案>\`。`,
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

  private async interactiveUpdate(
    activeTurn: ActiveTurn,
    text: string,
    templateCard: TemplateCard,
  ): Promise<WsFrame> {
    const textReply = activeTurn.outputMode === 'proactive'
      ? await this.sendProactiveText(activeTurn, text)
      : await this.finish(activeTurn.frame, activeTurn.streamId, text)
    await this.sendTemplateCard(activeTurn, templateCard)
    return textReply
  }

  private async sendTemplateCard(activeTurn: ActiveTurn, templateCard: TemplateCard): Promise<void> {
    try {
      await this.replies.sendMessage(activeTurn.targetId, {
        msgtype: 'template_card',
        template_card: templateCard,
      })
    } catch (error: unknown) {
      this.logger.warn(`wecom-aibot: proactive template card failed: ${String(error)}`)
    }
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

  private async ensureSession(key: string, requested: string): Promise<string> {
    return ensureConversationSession({
      api: this.api,
      key,
      requested,
      defaultWorkspaceId: this.runtime.defaultWorkspace.workspaceId,
      bindings: this.runtime.bindings,
      create: (id, workspace) => this.createSession(id, workspace),
    })
  }

  private async createSession(sessionId: string, workspaceId: string): Promise<string> {
    return unwrap(await this.api.sessions.create(apiRequest({
      sessionId,
      workspaceId,
      ...this.config.model === undefined ? {} : { model: this.config.model },
      ...this.agentPreset === undefined ? {} : { agentPreset: this.agentPreset },
    }))).sessionId
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
    if (command === '/myname') {
      const name = groupName.safeParse(args.join(' '))
      if (!name.success || name.data === message.userId) return '用法：/myname <显示姓名>（最多 100 个字符）'
      if (!this.runtime.sources) return '当前部署无法保存显示名。'
      await this.runtime.sources.nameSelf(message, name.data)
      return '已设置你的提问显示名：' + name.data
    }
    if (command === '/compact' && args.length === 0) {
      if (!this.adminUsers.has(message.userId)) return commandPermissionReply(message.userId)
      return undefined
    }
    if (!this.adminUsers.has(message.userId)) return commandPermissionReply(message.userId)
    const cmdCtx = this.commandContext()
    switch (command) {
      case '/groupname': {
        if (message.chatType !== 'group') return '请在要命名的群聊中使用 /groupname。'
        const name = groupName.safeParse(args.join(' '))
        if (!name.success) return '用法：/groupname <群名>（最多 100 个字符）'
        if (!this.runtime.sources) return '当前部署无法保存群名。'
        await this.runtime.sources.nameGroup(conversationKey, name.data)
        return '已更新这个群在 DSH 中显示的名称。'
      }
      case '/help': return COMMAND_HELP
      case '/status': return await statusCommand(cmdCtx, sessionId)
      case '/new': return args.length === 0
        ? await newSessionCommand(cmdCtx, conversationKey, sessionId, '已创建并切换到新会话（当前工作区）。发送 /session 可切回历史会话。')
        : '用法：/new'
      case '/session': return await runSessionCommand({
        sessions: this.api.sessions,
        bindings: this.runtime.bindings,
        key: conversationKey,
        currentSessionId: sessionId,
        args,
        titlePrefix: '【企业微信】',
      })
      case '/workspace': return await this.workspace(conversationKey, sessionId, args)
      case '/preset': return await presetCommand(cmdCtx, conversationKey, sessionId, args)
      case '/model': return await modelCommand(cmdCtx, sessionId, args)
      case '/effort': return await effortCommand(cmdCtx, sessionId, args)
      default: return `未知命令：${command}\n\n${COMMAND_HELP}`
    }
  }

  private async workspace(
    conversationKey: string,
    currentSessionId: string,
    args: readonly string[],
  ): Promise<string> {
    const workspaces = await listHostWorkspaces(this.api, 'wecom-api')
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
      : selectWorkspace(workspaces, selector ?? '')
    if (target === undefined) {
      return selector === 'reset'
        ? '默认工作区已不存在，请在插件设置中重新选择。'
        : `没有找到工作区“${selector}”；发送 /workspace 查看可选项。`
    }
    if (target.workspaceId === current?.workspaceId) return `当前已经在工作区“${target.title}”。`
    const sessionId = await this.createSession(`session-wecom-${randomUUID().replaceAll('-', '')}`, target.workspaceId)
    await this.runtime.bindings.set(conversationKey, sessionId, current === undefined ? undefined : currentSessionId)
    return `已切换到工作区“${target.title}”并创建新会话。旧会话仍保留。`
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
    let lastProgress = performance.now()
    const started = lastProgress
    const projection = new TurnProjection(options.promptRpcId, this.config.finalReplyOnly)
    let resolveOutcome: (value: TurnOutcome) => void = () => undefined
    let rejectOutcome: (error: unknown) => void = () => undefined
    const outcome = new Promise<TurnOutcome>((resolve, reject) => {
      resolveOutcome = resolve
      rejectOutcome = reject
    })
    void outcome.catch(() => undefined)
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
      if (this.config.finalReplyOnly && projection.ownsProgress(event)) lastProgress = performance.now()
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
    const idleLimit = this.config.turnTimeoutMs
    const maximum = this.config.finalReplyOnly ? Math.max(idleLimit, MAX_FINAL_OBSERVATION_MS) : idleLimit
    const checkDeadline = (): void => {
      const now = performance.now()
      const remaining = Math.min(maximum - (now - started), idleLimit - (now - lastProgress))
      if (remaining > 0) timeout = setTimeout(checkDeadline, remaining)
      else settle(new TurnObservationTimeout('wecom-aibot: turn observation deadline reached'))
    }
    let timeout = setTimeout(checkDeadline, idleLimit)
    return {
      outcome,
      dispose: () => settle({ text: '', images: [], files: [], reason: { kind: 'aborted' } }),
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
