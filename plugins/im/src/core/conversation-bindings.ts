/** Durable channel conversation-to-Session bindings without raw chat identifiers. */

import { readFile } from 'node:fs/promises'
import { writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'

interface BindingDocument {
  version: 1
  bindings: Record<string, string>
  histories: Record<string, string[]>
}

const validKey = (key: string) => /^[a-f0-9]{64}$/u.test(key)
type SessionValidator = (id: unknown) => id is string

function parseDocument(text: string, validSession: SessionValidator): BindingDocument {
  const value: unknown = JSON.parse(text)
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('IM bindings document must be an object')
  }
  const document = value as { version?: unknown; bindings?: unknown }
  if (document.version !== 1 || typeof document.bindings !== 'object'
    || document.bindings === null || Array.isArray(document.bindings)) {
    throw new Error('IM bindings document has an unsupported format')
  }
  const bindings: Record<string, string> = {}
  for (const [key, sessionId] of Object.entries(document.bindings)) {
    if (!validKey(key) || !validSession(sessionId)) {
      throw new Error('IM bindings document contains an invalid binding')
    }
    bindings[key] = sessionId
  }
  const raw = document as typeof document & { histories?: unknown }
  if (raw.histories !== undefined && (raw.histories === null || typeof raw.histories !== 'object' || Array.isArray(raw.histories))) {
    throw new Error('IM bindings document contains invalid histories')
  }
  const histories: Record<string, string[]> = {}
  for (const [key, ids] of Object.entries(raw.histories ?? {})) {
    if (!validKey(key) || !Array.isArray(ids) || !ids.every(validSession) || new Set(ids).size !== ids.length) {
      throw new Error('IM bindings document contains an invalid history')
    }
    histories[key] = ids
  }
  for (const [key, id] of Object.entries(bindings)) {
    histories[key] = [...new Set([...(histories[key] ?? []), id])]
  }
  return { version: 1, bindings, histories }
}

/** Owner-only JSON persistence for the active Session of each channel conversation. */
export class ConversationBindings {
  private readonly bindings = new Map<string, string>()
  private readonly histories = new Map<string, string[]>()
  private writeTail: Promise<void> = Promise.resolve()

  private constructor(private readonly filename: string, private readonly validSession: SessionValidator) {}

  static async open(filename: string, channel: 'wechat' | 'wecom'): Promise<ConversationBindings> {
    const validSession = (id: unknown): id is string => typeof id === 'string' && id.startsWith(`session-${channel}-`)
    const store = new ConversationBindings(filename, validSession)
    try {
      const parsed = parseDocument(await readFile(filename, 'utf8'), validSession)
      for (const [key, sessionId] of Object.entries(parsed.bindings)) store.bindings.set(key, sessionId)
      for (const [key, ids] of Object.entries(parsed.histories)) store.histories.set(key, ids)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    return store
  }

  current(key: string, fallback: string): string {
    return this.bindings.get(key) ?? fallback
  }

  /** Creation order gives stable selection numbers even after another turn updates a title. */
  list(key: string, fallback: string): string[] {
    return [...new Set([...(this.histories.get(key) ?? []), this.current(key, fallback)])]
  }

  async set(key: string, sessionId: string, previousSessionId?: string): Promise<void> {
    if (!validKey(key) || !this.validSession(sessionId) || (previousSessionId !== undefined && !this.validSession(previousSessionId))) {
      throw new Error('im: invalid conversation binding')
    }
    const operation = this.writeTail.then(async () => {
      const previous = this.bindings.get(key)
      const ids = [...new Set([...(this.histories.get(key) ?? []),
        ...(previousSessionId === undefined ? [] : [previousSessionId]),
        ...(previous === undefined ? [] : [previous]), sessionId])]
      if (previous === sessionId && ids.length === this.histories.get(key)?.length) return
      const document: BindingDocument = { version: 1,
        bindings: { ...Object.fromEntries(this.bindings), [key]: sessionId },
        histories: { ...Object.fromEntries(this.histories), [key]: ids } }
      await writeFileAtomic(this.filename, `${JSON.stringify(document, null, 2)}\n`, { mode: 0o600, dirMode: 0o700 })
      // Publish both pointers only after the single durable write commits.
      this.bindings.set(key, sessionId)
      this.histories.set(key, ids)
    })
    this.writeTail = operation.catch(() => undefined)
    await operation
  }

  async drain(): Promise<void> {
    await this.writeTail
  }
}
