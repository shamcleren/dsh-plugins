import { readFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import type { WeChatAccountCredentials } from './protocol.js'

interface AccountDocument {
  version: 1
  accounts: Record<string, WeChatAccountCredentials>
  cursors: Record<string, string>
  contextTokens: Record<string, string>
}

const EMPTY_DOCUMENT: AccountDocument = { version: 1, accounts: {}, cursors: {}, contextTokens: {} }

function parseDocument(text: string): AccountDocument {
  const parsed = JSON.parse(text) as Partial<AccountDocument>
  if (parsed.version !== 1 || !plainRecord(parsed.accounts)
    || !plainRecord(parsed.cursors) || !plainRecord(parsed.contextTokens)) {
    throw new Error('wechat: account document has an unsupported format')
  }
  const accounts: Record<string, WeChatAccountCredentials> = {}
  for (const [accountId, account] of Object.entries(parsed.accounts)) {
    if (!plainRecord(account) || account.accountId !== accountId || !nonEmptyString(account.token)
      || !nonEmptyString(account.baseUrl) || !optionalString(account.userId)) {
      throw new Error('wechat: account document contains an invalid account')
    }
    accounts[accountId] = account as unknown as WeChatAccountCredentials
  }
  return { version: 1, accounts, cursors: stringRecord(parsed.cursors),
    contextTokens: stringRecord(parsed.contextTokens) }
}

function plainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function optionalString(value: unknown): boolean {
  return value === undefined || typeof value === 'string'
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0
}

function contextKey(accountId: string, userId: string): string {
  return createHash('sha256').update(JSON.stringify([accountId, userId])).digest('hex')
}

function stringRecord(record: Record<string, unknown>): Record<string, string> {
  for (const value of Object.values(record)) {
    if (typeof value !== 'string') throw new Error('wechat: account document contains a non-string state value')
  }
  return record as Record<string, string>
}

/** Owner-only account, cursor, and reply-context persistence. */
export class WeChatAccountStore {
  private writeTail: Promise<void> = Promise.resolve()

  private constructor(
    private readonly filename: string,
    private readonly document: AccountDocument,
  ) {}

  static async open(channelHome: string): Promise<WeChatAccountStore> {
    const filename = join(channelHome, 'accounts.json')
    try {
      return new WeChatAccountStore(filename, parseDocument(await readFile(filename, 'utf8')))
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      return new WeChatAccountStore(filename, structuredClone(EMPTY_DOCUMENT))
    }
  }

  accounts(selected: readonly string[]): WeChatAccountCredentials[] {
    const accounts = Object.values(this.document.accounts)
    return selected.length === 0 ? accounts : accounts.filter(account => selected.includes(account.accountId))
  }

  tokens(): string[] {
    return Object.values(this.document.accounts).map(account => account.token)
  }

  cursor(accountId: string): string {
    return this.document.cursors[accountId] ?? ''
  }

  contextToken(accountId: string, userId: string): string | undefined {
    return this.document.contextTokens[contextKey(accountId, userId)]
  }

  async saveAccount(account: WeChatAccountCredentials): Promise<void> {
    this.document.accounts[account.accountId] = account
    await this.persist()
  }

  async saveCursor(accountId: string, cursor: string): Promise<void> {
    this.document.cursors[accountId] = cursor
    await this.persist()
  }

  async saveContextToken(accountId: string, userId: string, token: string): Promise<void> {
    this.document.contextTokens[contextKey(accountId, userId)] = token
    await this.persist()
  }

  async drain(): Promise<void> {
    await this.writeTail
  }

  private async persist(): Promise<void> {
    const snapshot = `${JSON.stringify(this.document, null, 2)}\n`
    const write = this.writeTail.then(async () => {
      await writeFileAtomic(this.filename, snapshot, { mode: 0o600, dirMode: 0o700 })
    })
    this.writeTail = write.catch(() => undefined)
    await write
  }
}
