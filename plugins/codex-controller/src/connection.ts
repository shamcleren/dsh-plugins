/** One Codex app-server process and its persistent thread. */
import { JsonRpcLineTransport } from '@deepseek-ai/dsh-sdk-protocol'
import type { Readable, Writable } from 'node:stream'

export interface CodexChild {
  stdin?: Writable
  stdout?: Readable
  stderr?: Readable
  done: Promise<{ exitCode: number | null; signal: NodeJS.Signals | null }>
  terminate(): void
  waitForExit(signal?: AbortSignal): Promise<boolean>
}

export type CodexTurnInput =
  | { type: 'text'; text: string; text_elements: [] }
  | { type: 'image'; url: string }
  | { type: 'localImage'; path: string }

export interface CodexSpawn {
  (spec: { argv: readonly string[]; cwd: string; graceMs: number; env?: NodeJS.ProcessEnv }): CodexChild
}

export interface TurnEnd {
  status: 'completed' | 'interrupted' | 'failed'
  error?: string
}

interface Waiter { resolve(value: TurnEnd): void; reject(error: Error): void }

/** Owns handshake, thread resume, one in-flight turn, and process-tree teardown. */
export class CodexConnection {
  readonly notifications: Array<{ method: string; params: Record<string, unknown> }> = []
  private readonly transport: JsonRpcLineTransport
  private readonly fatal = Promise.withResolvers<never>()
  private threadId: string | undefined
  private turnId: string | undefined
  private appliedModel: string | undefined
  private appliedEffort: string | undefined
  private waiter: Waiter | undefined
  private closed = false

  constructor(
    private readonly child: CodexChild,
    private readonly onServerRequest: (method: string, params: Record<string, unknown>) => Promise<unknown>,
    private readonly onNotification: (method: string, params: Record<string, unknown>) => void,
  ) {
    if (!child.stdout || !child.stdin) throw new Error('codex-controller: app-server stdio is not a pipe')
    this.transport = new JsonRpcLineTransport(child.stdout, child.stdin)
    this.fatal.promise.catch(() => {})
    this.transport.onRequest((method, params) => this.onServerRequest(method, params))
    this.transport.onNotification((method, params) => this.observe(method, params))
    child.stdout.on('error', error => this.fail(error))
    child.stdin.on('error', error => this.fail(error))
    child.stderr?.resume()
  }

  start(): void { this.transport.start() }

  matches(model: string | undefined, effort: string | undefined): boolean {
    return this.appliedModel === model && this.appliedEffort === effort
  }

  async initialize(signal: AbortSignal): Promise<void> {
    const clientInfo = { name: 'dsh-codex-controller', title: 'DSH Codex Controller', version: '0.3.0' }
    await this.request('initialize', { clientInfo, capabilities: { experimentalApi: false } }, signal)
    this.transport.notify('initialized')
    await this.transport.flush()
  }

  async rateLimits(signal: AbortSignal): Promise<Record<string, unknown> | undefined> {
    try {
      const response = await this.request('account/rateLimits/read', {}, AbortSignal.any([signal, AbortSignal.timeout(2500)]))
      return isRecord(response) ? response : undefined
    } catch {
      return
    }
  }

  async openThread(cwd: string, model: string | undefined, existing: string | undefined, signal: AbortSignal, effort?: string): Promise<string> {
    this.appliedModel = model
    this.appliedEffort = effort
    const params = { cwd, ...(model ? { model } : {}), ...(effort ? { config: { model_reasoning_effort: effort } } : {}), approvalPolicy: 'on-request', sandbox: 'workspace-write' }
    try {
      const response = await this.request(existing ? 'thread/resume' : 'thread/start', existing ? { threadId: existing, ...params } : params, signal)
      this.threadId = threadId(response, existing ? 'thread/resume' : 'thread/start')
    } catch (error) {
      if (!existing) throw error
      const response = await this.request('thread/start', params, signal)
      this.threadId = threadId(response, 'thread/start')
    }
    return this.threadId
  }

  async turn(input: readonly CodexTurnInput[], signal: AbortSignal): Promise<TurnEnd> {
    if (!this.threadId) throw new Error('codex-controller: thread is not open')
    const completion = Promise.withResolvers<TurnEnd>()
    this.waiter = { resolve: completion.resolve, reject: completion.reject }
    try {
      const response = await this.request('turn/start', { threadId: this.threadId, input }, signal)
      this.turnId = threadId(response, 'turn/start', 'turn')
      return await completion.promise
    } finally {
      this.waiter = undefined
      this.turnId = undefined
    }
  }

  interrupt(): void {
    if (!this.threadId || !this.turnId || this.closed) return
    this.transport.request('turn/interrupt', { threadId: this.threadId, turnId: this.turnId }).catch(() => {})
  }

  async dispose(): Promise<void> {
    if (this.closed) return
    this.closed = true
    this.transport.close()
    try { this.child.stdin?.end() } catch { /* already closed */ }
    this.child.terminate()
    await this.child.waitForExit(AbortSignal.timeout(3000)).catch(() => false)
    await this.child.done.catch(() => undefined)
  }

  private observe(method: string, params: Record<string, unknown>): void {
    this.notifications.push({ method, params: diagnosticParams(method, params) })
    if (this.notifications.length > 32) this.notifications.splice(0, this.notifications.length - 32)
    try { this.onNotification(method, params) } catch (error) { this.fail(error) }
    if (method !== 'turn/completed') return
    const turn = isRecord(params.turn) ? params.turn : undefined
    const status = turn?.status
    if (status !== 'completed' && status !== 'interrupted' && status !== 'failed') return
    const error = isRecord(turn?.error) && typeof turn.error.message === 'string' ? turn.error.message : undefined
    this.waiter?.resolve({ status, ...(error ? { error } : {}) })
  }

  private async request(method: string, params: object, signal: AbortSignal): Promise<unknown> {
    const exited = this.child.done.then(() => { throw new Error('codex-controller: app-server exited') })
    exited.catch(() => {})
    return await Promise.race([this.transport.request(method, params, signal), this.fatal.promise, exited])
  }

  private fail(error: unknown): void {
    const normalized = error instanceof Error ? error : new Error(String(error))
    this.waiter?.reject(normalized)
    this.fatal.reject(normalized)
  }
}

function threadId(response: unknown, method: string, field = 'thread'): string {
  const body = isRecord(response) ? response : {}
  const nested = isRecord(body[field]) ? body[field] : field === 'thread' ? body.thread : body.turn
  const record = isRecord(nested) ? nested : {}
  if (typeof record.id !== 'string' || !record.id) throw new Error(`codex-controller: ${method} returned no id`)
  return record.id
}

function diagnosticParams(method: string, params: Record<string, unknown>): Record<string, unknown> {
  if (method !== 'item/completed' || !isRecord(params.item) || params.item.type !== 'imageGeneration') return params
  return { ...params, item: { ...params.item, result: '[image omitted]' } }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}
