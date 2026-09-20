/** One account quota snapshot for every Codex session. A failed refresh keeps the last good value. */
import { createInterface } from 'node:readline'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { quotaUsage, type QuotaUsage } from './activity.js'
import { codexArgv } from './binary.js'
import type { CodexChild, CodexSpawn } from './connection.js'

export const ACCOUNT_QUOTA_REFRESH_MS = 60_000

interface RefreshOptions {
  intervalMs?: number
  readLive(signal: AbortSignal): Promise<Record<string, unknown> | undefined>
  spawn(): CodexSpawn | undefined
}

export class AccountQuota {
  private current: QuotaUsage | undefined
  private epoch = 0
  private inflight: Promise<void> | undefined
  private writes = Promise.resolve()
  private child: CodexChild | undefined
  private cancel = new AbortController()
  private options: RefreshOptions | undefined

  constructor(private readonly root: string) {}

  snapshot(): QuotaUsage | undefined {
    return this.current
  }

  observe(params: Record<string, unknown>): void {
    const quota = quotaUsage(params)
    if (quota) this.remember(quota)
  }

  start(options: RefreshOptions): () => void {
    this.options = options
    const epoch = this.epoch
    void this.load().then(() => { if (epoch === this.epoch) return this.refresh() })
    const timer = setInterval(() => { void this.refresh() }, options.intervalMs ?? ACCOUNT_QUOTA_REFRESH_MS)
    timer.unref?.()
    return () => {
      clearInterval(timer)
      this.stop()
    }
  }

  kick(): void {
    void this.refresh()
  }

  stop(): void {
    this.epoch += 1
    this.options = undefined
    this.cancel.abort()
    this.child?.terminate()
    this.child = undefined
  }

  async refresh(): Promise<void> {
    if (!this.options) return
    if (this.inflight) return this.inflight
    const epoch = this.epoch
    this.inflight = this.refreshOwned(epoch).finally(() => { this.inflight = undefined })
    return this.inflight
  }

  private async refreshOwned(epoch: number): Promise<void> {
    const options = this.options
    if (!options || epoch !== this.epoch) return
    try {
      const live = await options.readLive(AbortSignal.timeout(2500)).catch(() => undefined)
      if (epoch !== this.epoch) return
      const parsed = live ? quotaUsage(live) : undefined
      if (parsed) {
        this.remember(parsed)
        return
      }
      const spawn = options.spawn()
      if (!spawn || epoch !== this.epoch) return
      const probed = await this.probe(spawn, epoch)
      if (probed && epoch === this.epoch) this.remember(probed)
    } catch { /* a failed refresh keeps the last good snapshot */ }
  }

  private remember(quota: QuotaUsage): void {
    this.current = quota
    this.writes = this.writes.then(() => this.persist(quota)).catch(() => {})
  }

  private path(): string {
    return join(this.root, 'account', 'quota.json')
  }

  private async load(): Promise<void> {
    try {
      const parsed = parseStored(JSON.parse(await readFile(this.path(), 'utf8')))
      if (parsed && !this.current) this.current = parsed
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return
    }
  }

  private async persist(quota: QuotaUsage): Promise<void> {
    const path = this.path()
    await mkdir(dirname(path), { recursive: true, mode: 0o700 })
    const temporary = path + '.tmp'
    await writeFile(temporary, JSON.stringify(quota), { mode: 0o600 })
    await rename(temporary, path)
  }

  private async probe(spawn: CodexSpawn, epoch: number): Promise<QuotaUsage | undefined> {
    let child: CodexChild
    try {
      child = spawn({ argv: codexArgv(), cwd: homedir(), graceMs: 3000 })
    } catch {
      return
    }
    this.child = child
    try {
      if (epoch !== this.epoch) return
      return await readQuota(child, this.cancel.signal)
    } catch {
      return
    } finally {
      if (this.child === child) this.child = undefined
      child.terminate()
      await child.waitForExit(AbortSignal.timeout(3000)).catch(() => false)
    }
  }
}

async function readQuota(child: CodexChild, signal: AbortSignal): Promise<QuotaUsage | undefined> {
  if (!child.stdout || !child.stdin) return
  child.stderr?.resume()
  const lines = createInterface({ input: child.stdout })
  const waiting = new Map<number, (frame: { result?: unknown; error?: { message?: string } }) => void>()
  let next = 1
  lines.on('line', line => {
    try {
      const frame = JSON.parse(line) as { id?: number; result?: unknown; error?: { message?: string } }
      if (typeof frame.id !== 'number') return
      waiting.get(frame.id)?.(frame)
      waiting.delete(frame.id)
    } catch { /* ignore a non-JSON diagnostic line */ }
  })
  const request = (method: string, params: object): Promise<{ result?: unknown; error?: { message?: string } }> => new Promise((resolve, reject) => {
    const id = next++
    const timer = setTimeout(() => { waiting.delete(id); reject(new Error('codex-controller: account quota timed out')) }, 8000)
    const onAbort = () => { clearTimeout(timer); waiting.delete(id); reject(new Error('codex-controller: account quota stopped')) }
    if (signal.aborted) { onAbort(); return }
    signal.addEventListener('abort', onAbort, { once: true })
    waiting.set(id, frame => { clearTimeout(timer); signal.removeEventListener('abort', onAbort); resolve(frame) })
    child.stdin?.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n')
  })
  try {
    const initialized = await request('initialize', { clientInfo: { name: 'dsh-codex-controller', title: 'DSH Codex Controller', version: '0.3.0' }, capabilities: { experimentalApi: false } })
    if (initialized.error || !isRecord(initialized.result)) return
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'initialized', params: {} }) + '\n')
    const limits = await request('account/rateLimits/read', {})
    if (limits.error || !isRecord(limits.result)) return
    return quotaUsage(limits.result)
  } finally {
    lines.close()
    try { child.stdin.end() } catch { /* already closed */ }
  }
}

function parseStored(value: unknown): QuotaUsage | undefined {
  if (!isRecord(value)) return
  const remaining = finite(value.remaining)
  if (remaining === undefined || remaining > 100) return
  const resetsAt = value.resetsAt === undefined ? undefined : finite(value.resetsAt)
  const windowMinutes = value.windowMinutes === undefined ? undefined : finite(value.windowMinutes)
  if (value.resetsAt !== undefined && resetsAt === undefined) return
  if (value.windowMinutes !== undefined && windowMinutes === undefined) return
  return { remaining, ...(resetsAt ? { resetsAt } : {}), ...(windowMinutes ? { windowMinutes } : {}) }
}

function finite(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}
