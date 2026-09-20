/** Shared Codex session surface. The journal is the live working set; notices remain the durable transcript. */
import type { QuotaUsage } from './activity.js'
import type { SessionRecord } from './journal.js'

export const CODEX_CHANNEL = '/codex-controller'

export interface CreateRequest { cwd?: string }
export interface StateRequest { sessionId: string }

export interface CodexState { present: boolean; record: SessionRecord; quota?: QuotaUsage }

export function isSessionId(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9._-]{1,200}$/.test(value)
}
