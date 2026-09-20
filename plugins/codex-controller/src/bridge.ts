/** One DSH session, one Codex thread, and the visible activity that belongs to that pair. */
import { createUserMessage, type StreamChunk } from '@deepseek-ai/dsh-llm'
import type { ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { Session } from '@deepseek-ai/dsh-session'
import { contextUsage } from './activity.js'
import { approvalPrompt, approvalResponse, decisionFor, ELICITATION, nativelyApprovable, type DshOutcome } from './approval-map.js'
import { codexArgv } from './binary.js'
import { CodexConnection, type CodexSpawn, type CodexTurnInput, type TurnEnd } from './connection.js'
import { generatedImage } from './image-generation.js'
import { emptyRecord, readRecord, writeRecord, type SessionRecord } from './journal.js'
import { bound, PLUGIN, threadIdFromSession, threadNotice } from './transcript.js'

export interface BridgeHost {
  root: string
  spawn: CodexSpawn
  session(id: string): Session | undefined
  agent(id: string): Agent | undefined
  approve(agent: Agent, toolName: string, reason: string, signal: AbortSignal): Promise<DshOutcome>
  saveImage(data: Uint8Array, name: string): Promise<ImageAttachmentRef>
  imageInput(attachment: ImageAttachmentRef, signal: AbortSignal): Promise<CodexTurnInput>
  noteQuota?(params: Record<string, unknown>): void
  graceMs?: number
}

interface TurnRequest {
  sessionId: string
  cwd: string
  text: string
  images?: readonly ImageAttachmentRef[]
  model?: string
  effort?: string
  signal: AbortSignal
  onChunk(chunk: StreamChunk): void
}

interface ActiveTurn {
  emit(chunk: StreamChunk): void
  text: string
  reasoning: string
  emittedImages: number
  nextImageIndex: number
  completedImages: Set<string>
  pendingImages: Set<Promise<void>>
}

/** Serializes turns and publishes Codex activity without synthesizing DSH tool calls. */
export class CodexBridge {
  private readonly connections = new Map<string, CodexConnection>()
  private readonly opening = new Map<string, Promise<CodexConnection>>()
  private readonly queues = new Map<string, Promise<void>>()
  private readonly writes = new Map<string, Promise<void>>()
  private readonly turnWaiters = new Map<string, Array<(end: TurnEnd) => void>>()
  private readonly signals = new Map<string, AbortSignal>()
  private readonly lifetime = new AbortController()
  private readonly active = new Map<string, ActiveTurn>()

  constructor(private readonly host: BridgeHost) {}

  async run(request: TurnRequest): Promise<TurnEnd> {
    const previous = this.queues.get(request.sessionId) ?? Promise.resolve()
    const run = previous.catch(() => {}).then(() => this.runOwned(request))
    this.queues.set(request.sessionId, run.then(() => {}, () => {}))
    return await run
  }

  waitForTurn(sessionId: string, signal: AbortSignal): Promise<TurnEnd> {
    return new Promise(resolve => {
      const finish = (end: TurnEnd): void => {
        const waiters = this.turnWaiters.get(sessionId) ?? []
        this.turnWaiters.set(sessionId, waiters.filter(item => item !== finish))
        if (this.turnWaiters.get(sessionId)?.length === 0) this.turnWaiters.delete(sessionId)
        resolve(end)
      }
      const waiters = this.turnWaiters.get(sessionId) ?? []
      waiters.push(finish)
      this.turnWaiters.set(sessionId, waiters)
      signal.addEventListener('abort', () => finish({ status: 'interrupted' }), { once: true })
    })
  }

  async snapshot(sessionId: string): Promise<SessionRecord> {
    return await readRecord(this.host.root, sessionId) ?? emptyRecord(sessionId)
  }

  async sampleRateLimits(signal: AbortSignal): Promise<Record<string, unknown> | undefined> {
    const connection = this.connections.values().next().value
    if (!connection) return
    return connection.rateLimits(signal)
  }

  async remember(sessionId: string): Promise<void> {
    const current = await readRecord(this.host.root, sessionId)
    if (!current) await writeRecord(this.host.root, emptyRecord(sessionId))
  }

  async release(sessionId: string): Promise<void> {
    const connection = this.connections.get(sessionId)
    this.connections.delete(sessionId)
    if (connection) await connection.dispose().catch(() => {})
  }

  async close(): Promise<void> {
    this.lifetime.abort()
    const connections = [...this.connections.values()]
    this.connections.clear()
    await Promise.allSettled(connections.map(connection => connection.dispose()))
    await Promise.allSettled([...this.queues.values()])
  }

  private async runOwned(request: TurnRequest): Promise<TurnEnd> {
    request.signal.throwIfAborted()
    let connection: CodexConnection | undefined
    const abort = () => connection?.interrupt()
    request.signal.addEventListener('abort', abort, { once: true })
    try {
      connection = await this.connection(request)
      this.signals.set(request.sessionId, request.signal)
      this.active.set(request.sessionId, {
        emit: request.onChunk,
        text: '',
        reasoning: '',
        emittedImages: 0,
        nextImageIndex: 2,
        completedImages: new Set(),
        pendingImages: new Set(),
      })
      await this.update(request.sessionId, record => ({ ...record, status: 'running', error: undefined }))
      const input = await this.turnInput(request)
      const end = await connection.turn(input, request.signal)
      await this.waitForImages(request.sessionId)
      this.finishStream(request.sessionId, end)
      await this.update(request.sessionId, record => end.status === 'failed' && end.error ? { ...record, status: 'failed', error: end.error } : { ...withoutError(record), status: 'idle' })
      if (end.status === 'failed') this.notice(request.sessionId, 'Codex 回合失败', end.error ?? 'Codex turn failed')
      this.settle(request.sessionId, end)
      return end
    } catch (error) {
      if (request.signal.aborted) {
        await this.waitForImages(request.sessionId)
        this.finishStream(request.sessionId, { status: 'interrupted' })
        await this.update(request.sessionId, record => ({ ...record, status: 'idle' })).catch(() => {})
        this.settle(request.sessionId, { status: 'interrupted' })
        return { status: 'interrupted' }
      }
      const message = error instanceof Error ? error.message : String(error)
      await this.waitForImages(request.sessionId)
      this.finishStream(request.sessionId, { status: 'failed', error: message })
      await this.update(request.sessionId, record => ({ ...record, status: 'failed', error: message })).catch(() => {})
      this.notice(request.sessionId, 'Codex 连接失败', message)
      this.connections.delete(request.sessionId)
      await connection?.dispose().catch(() => {})
      const failed = { status: 'failed' as const, error: message }
      this.settle(request.sessionId, failed)
      return failed
    } finally {
      request.signal.removeEventListener('abort', abort)
      this.signals.delete(request.sessionId)
      this.active.delete(request.sessionId)
    }
  }

  private async connection(request: TurnRequest): Promise<CodexConnection> {
    const live = this.connections.get(request.sessionId)
    if (live?.matches(request.model, request.effort)) return live
    if (live) {
      this.connections.delete(request.sessionId)
      await live.dispose().catch(() => {})
    }
    const pending = this.opening.get(request.sessionId)
    if (pending) return await pending
    const opening = this.open(request)
    this.opening.set(request.sessionId, opening)
    try { return await opening } finally { this.opening.delete(request.sessionId) }
  }

  private async turnInput(request: TurnRequest): Promise<CodexTurnInput[]> {
    const text = request.text
      ? [{ type: 'text' as const, text: request.text, text_elements: [] as [] }]
      : []
    const images = await Promise.all((request.images ?? []).map(image => this.host.imageInput(image, request.signal)))
    return [...text, ...images]
  }

  private async open(request: TurnRequest): Promise<CodexConnection> {
    const child = this.host.spawn({ argv: codexArgv(), cwd: request.cwd, graceMs: this.host.graceMs ?? 3000 })
    const connection = new CodexConnection(child, (method, params) => this.serverRequest(request.sessionId, method, params), (method, params) => this.notification(request.sessionId, method, params))
    connection.start()
    try {
      await connection.initialize(request.signal)
      const stored = await this.snapshot(request.sessionId)
      const session = this.host.session(request.sessionId)
      const existing = stored.threadId ?? (session ? threadIdFromSession(session) : undefined)
      const threadId = await connection.openThread(request.cwd, request.model, existing, request.signal, request.effort)
      await this.update(request.sessionId, record => ({ ...record, threadId, ...(request.model ? { model: request.model } : { model: undefined }), ...(request.effort ? { effort: request.effort } : { effort: undefined }) }))
      if (threadId !== existing) {
        const note = threadNotice(threadId)
        this.notice(request.sessionId, existing ? 'Codex 会话已重建' : note.summary, existing ? threadNotice(threadId).text + '\n先前线程不可用，已开始新的 Codex 会话。' : note.text)
      }
      this.connections.set(request.sessionId, connection)
      const limits = await connection.rateLimits(request.signal)
      if (limits) this.host.noteQuota?.(limits)
      return connection
    } catch (error) {
      await connection.dispose().catch(() => {})
      throw error
    }
  }

  private notification(sessionId: string, method: string, params: Record<string, unknown>): void {
    if (method === 'thread/tokenUsage/updated') {
      const usage = contextUsage(params)
      if (usage) void this.update(sessionId, record => ({ ...record, usage })).catch(() => {})
      return
    }
    if (method === 'account/rateLimits/updated') {
      this.host.noteQuota?.(params)
      return
    }
    if (method === 'item/completed') this.projectGeneratedImage(sessionId, params)
    else if (method === 'item/agentMessage/delta' && typeof params.delta === 'string') this.delta(sessionId, 'text', params.delta)
    else if (method === 'item/reasoning/summaryTextDelta' && typeof params.delta === 'string') this.delta(sessionId, 'reasoning', params.delta)
  }

  private async serverRequest(sessionId: string, method: string, params: Record<string, unknown>): Promise<unknown> {
    if (nativelyApprovable(method, params)) {
      const prompt = approvalPrompt(method, params)
      const agent = this.host.agent(sessionId)
      const turn = this.signals.get(sessionId)
      const signal = AbortSignal.any([this.lifetime.signal, AbortSignal.timeout(APPROVAL_TIMEOUT_MS), ...(turn ? [turn] : [])])
      const outcome = agent ? await this.host.approve(agent, prompt.toolName, prompt.reason, signal) : 'unavailable'
      this.notice(sessionId, 'Codex 审批', prompt.reason + '\n' + outcome)
      return approvalResponse(method, params, decisionFor(outcome))
    }
    // DSH approval carries accept, decline, and cancel only. Decline what needs typed
    // answers instead of blocking the turn on an input surface the session does not have.
    if (method === ELICITATION) {
      this.notice(sessionId, 'Codex 请求已拒绝', declineDetail(params))
      return { action: 'decline' }
    }
    if (method === 'item/tool/requestUserInput') {
      this.notice(sessionId, 'Codex 请求已拒绝', declineDetail(params))
      throw new Error('codex-controller: ' + TYPED_ANSWER_DECLINED)
    }
    this.notice(sessionId, '未支持的 Codex 请求', method)
    throw new Error('codex-controller: unsupported request ' + method)
  }

  private delta(sessionId: string, kind: 'text' | 'reasoning', text: string): void {
    const active = this.active.get(sessionId)
    if (!active || !text) return
    const index = kind === 'text' ? 0 : 1
    if (kind === 'text' && !active.text) active.emit({ type: 'block-start', index, blockType: 'text' })
    if (kind === 'reasoning' && !active.reasoning) active.emit({ type: 'block-start', index, blockType: 'reasoning' })
    active[kind] += text
    active.emit(kind === 'text' ? { type: 'text-delta', index, text } : { type: 'reasoning-delta', index, text })
  }

  private projectGeneratedImage(sessionId: string, params: Record<string, unknown>): void {
    const generated = generatedImage(params)
    const active = this.active.get(sessionId)
    if (!generated || !active || active.completedImages.has(generated.id)) return
    active.completedImages.add(generated.id)
    const index = active.nextImageIndex++
    const save = this.host.saveImage(generated.bytes, generated.name).then(attachment => {
      if (this.active.get(sessionId) !== active) return
      active.emit({ type: 'block-start', index, blockType: 'image' })
      active.emit({ type: 'block-end', index, block: { type: 'image', attachment } })
      active.emittedImages += 1
    }).catch(() => {
      this.delta(sessionId, 'text', '\n\n图片已生成，但无法保存到 DSH 会话。')
    })
    active.pendingImages.add(save)
    void save.finally(() => { active.pendingImages.delete(save) })
  }

  private async waitForImages(sessionId: string): Promise<void> {
    const active = this.active.get(sessionId)
    while (active?.pendingImages.size) await Promise.allSettled([...active.pendingImages])
  }

  private finishStream(sessionId: string, end: TurnEnd): void {
    const active = this.active.get(sessionId)
    if (!active) return
    if (active.reasoning) active.emit({ type: 'block-end', index: 1, block: { type: 'reasoning', text: active.reasoning } })
    if (active.text) {
      active.emit({ type: 'block-end', index: 0, block: { type: 'text', text: active.text } })
    } else if (!active.emittedImages) {
      const text = end.status === 'completed' ? 'Codex 已完成本回合。' : end.error || 'Codex 回合已结束。'
      active.emit({ type: 'block-start', index: 0, blockType: 'text' })
      active.emit({ type: 'text-delta', index: 0, text })
      active.emit({ type: 'block-end', index: 0, block: { type: 'text', text } })
    }
    if (end.status === 'completed') active.emit({ type: 'finish', reason: { kind: 'stop' } })
    else if (end.status === 'interrupted') active.emit({ type: 'finish', reason: { kind: 'aborted', failure: { message: 'Codex turn interrupted', code: 'ABORTED' } } })
    else active.emit({ type: 'finish', reason: { kind: 'error', failure: { message: end.error ?? 'Codex turn failed', code: 'CODEX_TURN_FAILED' } } })
  }

  private notice(sessionId: string, summary: string, text: string): void {
    const session = this.host.session(sessionId)
    if (!session || !text.trim()) return
    session.append('user/message', createUserMessage({ source: { kind: 'plugin', plugin: PLUGIN, form: 'notice', summary: bound(summary) }, content: [{ type: 'text', text }] }), { surfaceOp: 'append' })
  }

  private settle(sessionId: string, end: TurnEnd): void {
    const waiters = this.turnWaiters.get(sessionId) ?? []
    this.turnWaiters.delete(sessionId)
    for (const resolve of waiters) resolve(end)
  }

  private async update(sessionId: string, change: (record: SessionRecord) => SessionRecord): Promise<void> {
    const previous = this.writes.get(sessionId) ?? Promise.resolve()
    const write = previous.catch(() => {}).then(async () => {
      const current = await this.snapshot(sessionId)
      const next = change(current)
      const { error: _error, ...rest } = next
      await writeRecord(this.host.root, next.error === undefined ? rest : next)
    })
    this.writes.set(sessionId, write.then(() => {}, () => {}))
    await write
  }
}

const APPROVAL_TIMEOUT_MS = 5 * 60 * 1000
const TYPED_ANSWER_DECLINED = 'DSH 审批只有同意、拒绝和取消，无法代填 Codex 要求的文本回答，本次请求按拒绝处理。'

function declineDetail(params: Record<string, unknown>): string {
  const message = typeof params.message === 'string' ? params.message.trim() : ''
  return message ? TYPED_ANSWER_DECLINED + '\n' + message : TYPED_ANSWER_DECLINED
}

function withoutError(record: SessionRecord): SessionRecord {
  const { error: _error, ...rest } = record
  return rest
}


export type { TurnEnd }
