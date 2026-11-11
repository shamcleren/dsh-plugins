import { createHash, randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import { z } from 'zod'
import { sendMessage, WeChatSendError } from './api.js'
import type { ConversationBindings } from './bindings.js'
import type { MessageItem, WeChatAccountCredentials } from './protocol.js'
import type { WeChatAccountStore } from './storage.js'

const WINDOW_MS = 24 * 60 * 60_000
const PUSH_INTERVAL_MS = 10_000
const MAX_PENDING = 100
const id = z.string().min(1).max(512)
const timestamp = z.number().int().nonnegative()
const peerSchema = z.object({
  accountId: id, userId: id, credential: id, seenAt: timestamp,
  inboundIds: z.array(id).max(256), sent: z.number().int().nonnegative(), blocked: z.boolean(),
}).strict()
const statusSchema = z.enum(['queued', 'sending', 'sent', 'failed', 'uncertain', 'cancelled'])
const jobSchema = z.object({
  id, recipientId: id, credential: id, text: z.string().min(1).max(16_000),
  status: statusSchema, createdAt: timestamp, expiresAt: timestamp, nextAttemptAt: timestamp,
  sentChunks: z.number().int().min(0).max(5), code: z.string().max(100).optional(),
  key: z.string().max(1_024).optional(), sessionId: id.optional(),
}).strict()
const documentSchema = z.object({
  version: z.literal(1), peers: z.record(z.string().regex(/^[a-f0-9]{64}$/u), peerSchema),
  jobs: z.array(jobSchema).max(300), lastPushAt: timestamp,
}).strict()
const requestSchema = z.object({
  text: z.string().trim().min(1).max(16_000), recipientId: id.optional(), accountId: id.optional(),
  idempotencyKey: z.string().min(1).max(200).optional(),
}).strict()
type Peer = z.infer<typeof peerSchema>
type Job = z.infer<typeof jobSchema>
type Document = z.infer<typeof documentSchema>

export interface WeChatPushRequest {
  text: string
  recipientId?: string
  accountId?: string
  /** Reuse the same key for retries of one scheduled occurrence, not all occurrences. */
  idempotencyKey?: string
}
export interface WeChatRecipient {
  recipientId: string
  accountId: string
  userId: string
  owner: boolean
  available: boolean
  lastReceivedAt: number
}
export interface WeChatPushReceipt {
  id: string
  recipientId: string
  status: Job['status']
  sentChunks: number
  totalChunks: number
  code?: string
  nextAttemptAt: number
  expiresAt: number
}

export class WeChatPushError extends Error {
  constructor(readonly code: string) { super(`wechat: ${code}`) }
}

export function recipientIdFor(accountId: string, userId: string): string {
  return createHash('sha256').update(JSON.stringify([accountId, userId])).digest('hex')
}
function credentialId(account: WeChatAccountCredentials): string {
  return createHash('sha256').update(account.token).digest('hex')
}
function chunks(text: string): string[] {
  const result: string[] = []
  let current = ''
  for (const point of text) {
    if (current.length + point.length > 4_000) { result.push(current); current = '' }
    current += point
  }
  if (current) result.push(current)
  return result
}
function receipt(job: Job): WeChatPushReceipt {
  return { id: job.id, recipientId: job.recipientId, status: job.status,
    sentChunks: job.sentChunks, totalChunks: chunks(job.text).length,
    nextAttemptAt: job.nextAttemptAt, expiresAt: job.expiresAt,
    ...job.code === undefined ? {} : { code: job.code } }
}

/** One durable notification queue and a shared, serialized per-peer send budget. */
export class WeChatDelivery {
  private writes: Promise<void> = Promise.resolve()
  private readonly sends = new Map<string, Promise<void>>()
  private timer: ReturnType<typeof setTimeout> | undefined
  private worker: Promise<void> | undefined
  private abort = new AbortController()
  private paused = true
  private stopped = false
  private faulted = false

  private constructor(
    private readonly filename: string,
    private document: Document,
    private readonly accounts: WeChatAccountStore,
    private readonly bindings: Pick<ConversationBindings, 'current'>,
    private readonly activeAccounts: () => readonly string[],
    private readonly onError: () => void,
  ) {}

  static async open(home: string, accounts: WeChatAccountStore,
    bindings: Pick<ConversationBindings, 'current'>, activeAccounts: () => readonly string[],
    onError: () => void): Promise<WeChatDelivery> {
    const filename = join(home, 'outbox.json')
    let document: Document = { version: 1, peers: {}, jobs: [], lastPushAt: 0 }
    try { document = documentSchema.parse(JSON.parse(await readFile(filename, 'utf8'))) }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new WeChatPushError('outbox-unreadable')
    }
    for (const [key, peer] of Object.entries(document.peers)) {
      if (key !== recipientIdFor(peer.accountId, peer.userId)) throw new WeChatPushError('outbox-unreadable')
    }
    for (const job of document.jobs) {
      if (!document.peers[job.recipientId] || job.sentChunks > chunks(job.text).length) throw new WeChatPushError('outbox-unreadable')
      // A crash after dispatch can leave the remote outcome unknowable. Never replay it.
      if (job.status === 'sending') { job.status = 'uncertain'; job.code = 'interrupted-send' }
    }
    const delivery = new WeChatDelivery(filename, document, accounts, bindings, activeAccounts, onError)
    await delivery.change(() => undefined)
    return delivery
  }

  private account(peer: Peer): WeChatAccountCredentials | undefined {
    return this.accounts.accounts([]).find(account => account.accountId === peer.accountId
      && credentialId(account) === peer.credential)
  }

  private boundRecipient(sessionId: string): string | undefined {
    return Object.keys(this.document.peers).find(key =>
      this.bindings.current(key, `session-wechat-${key}`) === sessionId)
  }

  recipients(sessionId?: string): WeChatRecipient[] {
    const bound = sessionId === undefined ? undefined : this.boundRecipient(sessionId)
    return Object.entries(this.document.peers).filter(([key]) =>
      sessionId?.startsWith('session-wechat-') ? key === bound : bound === undefined || key === bound)
      .flatMap(([key, peer]) => {
        const account = this.account(peer)
        if (!account) return []
        return [{ recipientId: key, accountId: peer.accountId, userId: peer.userId,
          owner: account.userId === peer.userId, lastReceivedAt: peer.seenAt,
          available: !this.stopped && !this.faulted && this.activeAccounts().includes(peer.accountId) && !peer.blocked
            && Date.now() < peer.seenAt + WINDOW_MS
            && Boolean(this.accounts.contextToken(peer.accountId, peer.userId)) }]
      })
  }

  private target(request: z.infer<typeof requestSchema>, sessionId?: string): string {
    const bound = sessionId === undefined ? undefined : this.boundRecipient(sessionId)
    if (sessionId?.startsWith('session-wechat-') && !bound) throw new WeChatPushError('unbound-channel-session')
    if (bound && request.recipientId !== undefined && request.recipientId !== bound) throw new WeChatPushError('recipient-not-owned')
    if (!bound && request.accountId === undefined && request.recipientId === undefined
      && this.accounts.accounts([]).length > 1) throw new WeChatPushError('recipient-ambiguous')
    const candidates = this.recipients(sessionId).filter(peer =>
      (request.recipientId === undefined ? bound ? peer.recipientId === bound : peer.owner : peer.recipientId === request.recipientId)
      && (request.accountId === undefined || peer.accountId === request.accountId))
    if (candidates.length !== 1) throw new WeChatPushError(candidates.length > 1 ? 'recipient-ambiguous' : 'recipient-unavailable')
    if (!candidates[0]!.available) throw new WeChatPushError('recipient-needs-message')
    return candidates[0]!.recipientId
  }

  async notify(input: WeChatPushRequest, sessionId?: string, signal?: AbortSignal): Promise<WeChatPushReceipt> {
    const parsed = requestSchema.safeParse(input)
    if (!parsed.success) throw new WeChatPushError('invalid-request')
    const request = parsed.data
    const key = request.idempotencyKey === undefined ? undefined
      : JSON.stringify([sessionId ?? 'service', request.idempotencyKey])
    const result = await this.change(() => {
      signal?.throwIfAborted()
      if (this.stopped) throw new WeChatPushError('stopped')
      const previous = key === undefined ? undefined : this.document.jobs.find(job => job.key === key)
      if (previous) {
        if (previous.text !== request.text
          || request.recipientId !== undefined && previous.recipientId !== request.recipientId
          || request.accountId !== undefined && this.document.peers[previous.recipientId]?.accountId !== request.accountId) throw new WeChatPushError('idempotency-conflict')
        return receipt(previous)
      }
      const recipientId = this.target(request, sessionId)
      if (this.document.jobs.filter(job => ['queued', 'sending'].includes(job.status)).length >= MAX_PENDING) throw new WeChatPushError('queue-full')
      this.document.jobs = this.document.jobs.filter(job => ['queued', 'sending'].includes(job.status)
        || job.createdAt > Date.now() - 7 * WINDOW_MS)
      while (this.document.jobs.length >= 300) {
        const index = this.document.jobs.findIndex(job => !['queued', 'sending'].includes(job.status))
        this.document.jobs.splice(index, 1)
      }
      const now = Date.now()
      const job: Job = { id: randomUUID(), recipientId,
        credential: this.document.peers[recipientId]!.credential, text: request.text,
        status: 'queued', createdAt: now, expiresAt: now + WINDOW_MS,
        nextAttemptAt: now, sentChunks: 0,
        ...key === undefined ? {} : { key }, ...sessionId === undefined ? {} : { sessionId } }
      this.document.jobs.push(job)
      return receipt(job)
    })
    this.wake()
    return result
  }

  status(jobId: string, sessionId?: string): WeChatPushReceipt {
    const job = this.document.jobs.find(job => job.id === jobId)
    if (!job || (sessionId !== undefined && job.sessionId !== sessionId)) throw new WeChatPushError('notification-not-found')
    return receipt(job)
  }

  async cancel(jobId: string, sessionId?: string): Promise<WeChatPushReceipt> {
    return this.change(() => {
      this.status(jobId, sessionId)
      const job = this.document.jobs.find(job => job.id === jobId)!
      if (job.status !== 'queued') throw new WeChatPushError('notification-not-queued')
      job.status = 'cancelled'
      return receipt(job)
    })
  }

  /** Duplicate callbacks must not refresh the window or replenish its budget. */
  async observe(account: WeChatAccountCredentials, userId: string, messageId: string): Promise<void> {
    if (!id.safeParse(userId).success || !id.safeParse(messageId).success || !id.safeParse(account.accountId).success) return
    await this.change(() => {
      const key = recipientIdFor(account.accountId, userId), previous = this.document.peers[key]
      if (previous?.credential === credentialId(account) && previous.inboundIds.includes(messageId)) return
      if (!previous && Object.keys(this.document.peers).length >= 1_024) return
      this.document.peers[key] = { accountId: account.accountId, userId,
        credential: credentialId(account), seenAt: Date.now(), sent: 0, blocked: false,
        inboundIds: [...(previous?.inboundIds ?? []), messageId].slice(-256) }
      for (const job of this.document.jobs) {
        if (job.recipientId === key && job.status === 'queued'
          && (job.code === 'waiting-for-message' || job.code === 'context')) {
          job.nextAttemptAt = Date.now(); delete job.code
        }
      }
    })
    this.wake()
  }

  /** Replies and notifications share a conservative ten-message interaction budget. */
  async send(account: WeChatAccountCredentials, userId: string, item: MessageItem,
    contextToken: string | undefined, signal: AbortSignal, jobId?: string): Promise<void> {
    if (this.stopped) throw new WeChatPushError('stopped')
    const key = recipientIdFor(account.accountId, userId)
    const work = (this.sends.get(key) ?? Promise.resolve()).then(async () => {
      signal.throwIfAborted()
      if (this.stopped) throw new WeChatPushError('stopped')
      let inboundId: string | undefined
      await this.change(() => {
        if (jobId && this.document.jobs.find(job => job.id === jobId)?.status !== 'queued') throw new WeChatPushError('notification-not-queued')
        const peer = this.document.peers[key]
        if (peer && peer.credential === credentialId(account)) {
          if (peer.blocked || peer.sent >= (jobId ? 8 : 10) || Date.now() >= peer.seenAt + WINDOW_MS) throw new WeChatPushError('waiting-for-message')
          inboundId = peer.inboundIds.at(-1)
          peer.sent += 1
        }
        if (jobId) {
          const job = this.document.jobs.find(job => job.id === jobId)!
          job.status = 'sending'
          this.document.lastPushAt = Date.now()
        }
      })
      let sentContext: string | undefined
      try {
        sentContext = jobId ? this.accounts.contextToken(account.accountId, userId) : contextToken
        await sendMessage({ ...account, userId, item, signal,
          ...sentContext === undefined ? {} : { contextToken: sentContext },
          ...jobId === undefined ? {} : { clientId: `dsh-wechat-push-${jobId}-${this.document.jobs.find(job => job.id === jobId)!.sentChunks}` } })
      } catch (error) {
        if (error instanceof WeChatSendError && error.kind === 'context') {
          await this.change(() => {
            const peer = this.document.peers[key]
            // A refusal from an older interaction cannot close a freshly renewed window.
            if (peer && peer.credential === credentialId(account) && peer.inboundIds.at(-1) === inboundId
              && this.accounts.contextToken(account.accountId, userId) === sentContext) peer.blocked = true
          })
        }
        throw error
      }
    })
    const settled = work.catch(() => undefined)
    this.sends.set(key, settled)
    try { await work } finally { if (this.sends.get(key) === settled) this.sends.delete(key) }
  }

  resume(): void {
    if (this.stopped || this.faulted) return
    this.paused = false
    this.abort = new AbortController()
    this.wake()
  }

  async pause(): Promise<void> {
    this.paused = true
    if (this.timer) clearTimeout(this.timer)
    this.timer = undefined
    this.abort.abort()
    await this.worker
  }

  async stop(): Promise<void> {
    this.stopped = true
    await this.pause()
    await Promise.allSettled([...this.sends.values()])
    await this.writes
  }

  private wake(): void {
    if (this.paused || this.stopped || this.faulted || this.worker) return
    if (this.timer) clearTimeout(this.timer)
    this.timer = undefined
    this.worker = this.process().catch(() => { this.faulted = true; this.onError() }).finally(() => {
      this.worker = undefined
      if (this.paused || this.stopped || this.faulted) return
      const pending = this.document.jobs.filter(job => job.status === 'queued')
      if (!pending.length) return
      const heads = pending.filter((job, index) => !pending.slice(0, index).some(previous => previous.recipientId === job.recipientId))
      const next = Math.min(...pending.map(job => job.expiresAt), ...heads.map(job =>
        Math.max(job.nextAttemptAt, this.document.lastPushAt + PUSH_INTERVAL_MS)))
      this.timer = setTimeout(() => { this.timer = undefined; this.wake() }, Math.max(1, next - Date.now()))
      this.timer.unref()
    })
  }

  private async process(): Promise<void> {
    await this.change(() => {
      for (const job of this.document.jobs) if (job.status === 'queued' && Date.now() >= job.expiresAt) {
        job.status = 'failed'; job.code = 'expired'
      }
    })
    const pending = this.document.jobs.filter(job => job.status === 'queued')
    const job = pending.find((candidate, index) => candidate.nextAttemptAt <= Date.now()
      && !pending.slice(0, index).some(previous => previous.recipientId === candidate.recipientId))
    if (!job || Date.now() < this.document.lastPushAt + PUSH_INTERVAL_MS || this.paused) return
    const peer = this.document.peers[job.recipientId]!, account = this.account(peer)
    const token = this.accounts.contextToken(peer.accountId, peer.userId)
    if (!account || credentialId(account) !== job.credential) {
      await this.change(() => { job.status = 'failed'; job.code = 'account-changed' })
      return
    }
    if (!this.activeAccounts().includes(peer.accountId) || !token || peer.blocked || Date.now() >= peer.seenAt + WINDOW_MS) {
      await this.change(() => { job.code = 'waiting-for-message'; job.nextAttemptAt = job.expiresAt })
      return
    }
    try {
      await this.send(account, peer.userId, { type: 1, text_item: { text: chunks(job.text)[job.sentChunks]! } },
        token, this.abort.signal, job.id)
      await this.change(() => {
        job.sentChunks += 1
        job.status = job.sentChunks === chunks(job.text).length ? 'sent' : 'queued'
        job.nextAttemptAt = Date.now()
        delete job.code
      })
    } catch (error) {
      await this.change(() => {
        if (error instanceof WeChatPushError && error.code === 'notification-not-queued') return
        // A job waiting for a reply's send slot has not crossed the dispatch boundary.
        if (job.status === 'queued' && (this.abort.signal.aborted || this.stopped)) return
        job.code = error instanceof WeChatSendError ? error.kind : error instanceof WeChatPushError ? error.code : 'interrupted-send'
        if (error instanceof WeChatPushError && error.code === 'waiting-for-message'
          || error instanceof WeChatSendError && error.kind === 'context') {
          const peer = this.document.peers[job.recipientId]!
          job.status = 'queued'
          job.nextAttemptAt = !peer.blocked && peer.sent < 8 && Date.now() < peer.seenAt + WINDOW_MS
            ? Date.now() : job.expiresAt
        } else if (error instanceof WeChatSendError && error.kind === 'throttled') {
          job.status = 'queued'; job.nextAttemptAt = Date.now() + error.retryAfterMs
        } else { job.status = error instanceof WeChatSendError && error.kind === 'rejected' ? 'failed' : 'uncertain' }
      })
    }
  }

  private async change<T>(mutate: () => T): Promise<T> {
    const work = this.writes.then(async () => {
      if (this.faulted) throw new WeChatPushError('outbox-unavailable')
      const before = structuredClone(this.document)
      // Admission/cancellation failures are not storage failures. Mutators validate
      // before changing state; caller-defined abort reasons may be arbitrary values.
      const result = mutate()
      try {
        await writeFileAtomic(this.filename, `${JSON.stringify(this.document)}\n`, { mode: 0o600, dirMode: 0o700 })
        return result
      } catch {
        this.document = before
        this.faulted = true
        throw new WeChatPushError('outbox-unavailable')
      }
    })
    this.writes = work.then(() => undefined, () => undefined)
    return work
  }
}
