/** Plugin-owned session working set. Thread identity also has a session-notice backup. */
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { CodexActivity, ContextUsage, QuotaUsage } from './activity.js'

export interface SessionRecord {
  version: 1
  sessionId: string
  threadId?: string
  model?: string
  effort?: string
  status: 'idle' | 'running' | 'failed'
  usage?: ContextUsage
  /** Leftover field. Account quota is one process-wide snapshot, not per session. */
  quota?: QuotaUsage
  activities: CodexActivity[]
  error?: string
}

const NAME = /^[A-Za-z0-9._-]{1,200}$/
const ACTIVITY_LIMIT = 200

export function recordPath(root: string, sessionId: string): string | undefined {
  return NAME.test(sessionId) ? join(root, sessionId + '.json') : undefined
}

export async function readRecord(root: string, sessionId: string): Promise<SessionRecord | undefined> {
  const path = recordPath(root, sessionId)
  if (!path) return
  try {
    return parseRecord(JSON.parse(await readFile(path, 'utf8')), sessionId)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
    throw error
  }
}

export async function writeRecord(root: string, record: SessionRecord): Promise<void> {
  const path = recordPath(root, record.sessionId)
  if (!path) throw new Error('codex-controller: session id cannot be stored')
  await mkdir(root, { recursive: true, mode: 0o700 })
  const temporary = path + '.tmp'
  await writeFile(temporary, JSON.stringify(record), { mode: 0o600 })
  await rename(temporary, path)
}

export function emptyRecord(sessionId: string): SessionRecord {
  return { version: 1, sessionId, status: 'idle', activities: [] }
}

export function upsertActivity(record: SessionRecord, activity: CodexActivity): SessionRecord {
  const activities = [...record.activities.filter(item => item.id !== activity.id), activity].slice(-ACTIVITY_LIMIT)
  return { ...record, activities }
}

function parseRecord(value: unknown, sessionId: string): SessionRecord | undefined {
  if (!isRecord(value) || value.version !== 1 || value.sessionId !== sessionId) return
  const status = value.status === 'running' || value.status === 'failed' ? value.status : 'idle'
  return {
    version: 1, sessionId, status,
    ...(typeof value.threadId === 'string' ? { threadId: value.threadId } : {}),
    ...(typeof value.model === 'string' ? { model: value.model } : {}),
    ...(typeof value.effort === 'string' ? { effort: value.effort } : {}),
    ...(isUsage(value.usage) ? { usage: value.usage } : {}),
    ...(isQuota(value.quota) ? { quota: value.quota } : {}),
    activities: Array.isArray(value.activities) ? value.activities.filter(isActivity) : [],
    ...(typeof value.error === 'string' ? { error: value.error } : {}),
  }
}

function isUsage(value: unknown): value is ContextUsage {
  if (!isRecord(value)) return false
  const used = finite(value.used)
  const window = finite(value.window)
  const percent = finite(value.percent)
  return used !== undefined && window !== undefined && window > 0 && percent !== undefined && percent <= 100
}

function finite(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined
}

function isQuota(value: unknown): value is QuotaUsage {
  if (!isRecord(value)) return false
  const remaining = finite(value.remaining)
  const resetsAt = value.resetsAt === undefined ? undefined : finite(value.resetsAt)
  const windowMinutes = value.windowMinutes === undefined ? undefined : finite(value.windowMinutes)
  if (remaining === undefined || remaining > 100) return false
  if (value.resetsAt !== undefined && resetsAt === undefined) return false
  if (value.windowMinutes !== undefined && windowMinutes === undefined) return false
  return true
}

function isActivity(value: unknown): value is CodexActivity {
  return isRecord(value) && typeof value.id === 'string' && typeof value.kind === 'string' && typeof value.status === 'string' && typeof value.title === 'string' && typeof value.detail === 'string'
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}
