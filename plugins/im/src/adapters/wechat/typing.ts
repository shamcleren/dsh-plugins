const REFRESH_MS = 5_000
const CANCEL_TIMEOUT_MS = 5_000

type SendTyping = (userId: string, status: 1 | 2, contextToken: string | undefined, signal: AbortSignal) => Promise<void>

interface PeerTyping {
  userId: string
  contextToken: string | undefined
  owners: number
  abort: AbortController
  task: Promise<void>
  stopping?: Promise<void>
}

function pause(signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve()
  return new Promise(resolve => {
    const finish = () => { clearTimeout(timer); signal.removeEventListener('abort', finish); resolve() }
    const timer = setTimeout(finish, REFRESH_MS)
    signal.addEventListener('abort', finish, { once: true })
  })
}

/** One renewable indicator per peer, shared by every turn still delivering a reply. */
export class WeChatTyping {
  private readonly peers = new Map<string, PeerTyping>()
  private closed = false

  constructor(private readonly send: SendTyping, private readonly warn: () => void) {}

  update(key: string, contextToken: string | undefined): void {
    const entry = this.peers.get(key)
    if (entry !== undefined && contextToken !== undefined) entry.contextToken = contextToken
  }

  acquire(key: string, userId: string, contextToken: string | undefined): () => Promise<void> {
    if (this.closed) return async () => undefined
    let entry = this.peers.get(key)
    if (entry === undefined || entry.stopping !== undefined) {
      const previous = entry?.stopping
      entry = { userId, contextToken, owners: 0, abort: new AbortController(), task: Promise.resolve() }
      this.peers.set(key, entry)
      const current = entry
      // A retiring owner's cancel must finish before another owner starts typing.
      entry.task = previous === undefined ? this.refresh(current) : previous.then(() => this.refresh(current))
    }
    entry.owners += 1
    this.update(key, contextToken)
    const owned = entry
    let released = false
    return async () => {
      if (released) return
      released = true
      owned.owners -= 1
      if (owned.owners === 0) await this.retire(key, owned)
    }
  }

  async stop(): Promise<void> {
    this.closed = true
    await Promise.all([...this.peers].map(([key, entry]) => this.retire(key, entry)))
  }

  private async refresh(entry: PeerTyping): Promise<void> {
    const signal = entry.abort.signal
    while (!signal.aborted) {
      try { await this.send(entry.userId, 1, entry.contextToken, signal) }
      catch { if (!signal.aborted) this.warn() }
      await pause(signal)
    }
  }

  private retire(key: string, entry: PeerTyping): Promise<void> {
    if (entry.stopping !== undefined) return entry.stopping
    entry.abort.abort()
    entry.stopping = (async () => {
      await entry.task
      try { await this.send(entry.userId, 2, entry.contextToken, AbortSignal.timeout(CANCEL_TIMEOUT_MS)) }
      catch { this.warn() }
      finally { if (this.peers.get(key) === entry) this.peers.delete(key) }
    })()
    return entry.stopping
  }
}
