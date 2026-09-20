/** Durable WeChat conversation-to-Session bindings without raw chat identifiers. */

import { readFile } from 'node:fs/promises'
import { writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'

interface BindingDocument {
  version: 1
  bindings: Record<string, string>
}

function parseDocument(text: string): BindingDocument {
  const value: unknown = JSON.parse(text)
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('wechat bindings document must be an object')
  }
  const document = value as { version?: unknown; bindings?: unknown }
  if (document.version !== 1 || typeof document.bindings !== 'object'
    || document.bindings === null || Array.isArray(document.bindings)) {
    throw new Error('wechat bindings document has an unsupported format')
  }
  const bindings: Record<string, string> = {}
  for (const [key, sessionId] of Object.entries(document.bindings)) {
    if (!/^[a-f0-9]{64}$/u.test(key) || typeof sessionId !== 'string' || !sessionId.startsWith('session-wechat-')) {
      throw new Error('wechat bindings document contains an invalid binding')
    }
    bindings[key] = sessionId
  }
  return { version: 1, bindings }
}

/** Owner-only JSON persistence for the active Session of each WeChat conversation. */
export class ConversationBindings {
  private readonly bindings = new Map<string, string>()
  private writeTail: Promise<void> = Promise.resolve()

  private constructor(private readonly filename: string) {}

  static async open(filename: string): Promise<ConversationBindings> {
    const store = new ConversationBindings(filename)
    try {
      const parsed = parseDocument(await readFile(filename, 'utf8'))
      for (const [key, sessionId] of Object.entries(parsed.bindings)) store.bindings.set(key, sessionId)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    return store
  }

  current(key: string, fallback: string): string {
    return this.bindings.get(key) ?? fallback
  }

  async set(key: string, sessionId: string): Promise<void> {
    const previous = this.bindings.get(key)
    this.bindings.set(key, sessionId)
    try {
      await this.enqueueWrite()
    } catch (error) {
      if (previous === undefined) this.bindings.delete(key)
      else this.bindings.set(key, previous)
      throw error
    }
  }

  async drain(): Promise<void> {
    await this.writeTail
  }

  private async enqueueWrite(): Promise<void> {
    const document: BindingDocument = { version: 1, bindings: Object.fromEntries(this.bindings) }
    const operation = this.writeTail.then(async () => {
      await writeFileAtomic(this.filename, `${JSON.stringify(document, null, 2)}\n`, {
        mode: 0o600,
        dirMode: 0o700,
      })
    })
    this.writeTail = operation.catch(() => undefined)
    await operation
  }
}
