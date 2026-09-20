/** User-visible Codex activity. Unknown protocol events degrade instead of disappearing. */
export interface CodexActivity {
  id: string
  kind: string
  status: string
  title: string
  detail: string
}

/** Context fill from `thread/tokenUsage/updated`. Absent window means no percentage. */
export interface ContextUsage {
  used: number
  window: number
  percent: number
}

/** Account window from `account/rateLimits/updated`. Missing used percent means no bar. */
export interface QuotaUsage {
  remaining: number
  resetsAt?: number
  windowMinutes?: number
}

export function contextUsage(params: Record<string, unknown>): ContextUsage | undefined {
  const usage = isRecord(params.tokenUsage) ? params.tokenUsage : undefined
  const last = usage && isRecord(usage.last) ? usage.last : undefined
  const used = finite(last?.totalTokens)
  const window = finite(usage?.modelContextWindow)
  if (used === undefined || window === undefined || window <= 0) return
  return { used, window, percent: Math.min(100, Math.round((used / window) * 100)) }
}

const SECRET = /token|secret|password|authorization|api[-_]?key|credential/i
const DETAIL_LIMIT = 12_000

const VISIBLE_ITEMS = new Set(['commandExecution', 'fileChange', 'mcpToolCall', 'dynamicToolCall', 'webSearch', 'plan'])

export function quotaUsage(params: Record<string, unknown>): QuotaUsage | undefined {
  const snapshot = isRecord(params.rateLimits) ? params.rateLimits : params
  const windows = [quotaWindow(snapshot.primary), quotaWindow(snapshot.secondary)].filter((window): window is QuotaUsage => window !== undefined)
  if (!windows.length) return
  return windows.reduce((tightest, window) => window.remaining < tightest.remaining ? window : tightest)
}

function quotaWindow(value: unknown): QuotaUsage | undefined {
  if (!isRecord(value)) return
  const used = finite(value.usedPercent ?? value.used_percent)
  if (used === undefined || used > 100) return
  const resetsAt = instant(value.resetsAt ?? value.resets_at)
  const windowMinutes = finite(value.windowDurationMins ?? value.windowMinutes ?? value.window_minutes)
  return { remaining: Math.round(100 - used), ...(resetsAt ? { resetsAt } : {}), ...(windowMinutes ? { windowMinutes } : {}) }
}

function instant(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) return value < 1e12 ? value * 1000 : value
  if (typeof value !== 'string' || !value) return
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? parsed : undefined
}

export function projectItem(method: string, params: Record<string, unknown>): CodexActivity | undefined {
  const item = isRecord(params.item) ? params.item : undefined
  if (!item) return
  const type = text(item.type) || 'item'
  if (!VISIBLE_ITEMS.has(type)) return
  const id = text(item.id) || text(params.itemId) || method
  const status = method === 'item/completed' ? text(item.status) || 'completed' : text(item.status) || 'inProgress'
  return { id, kind: type, status, title: itemTitle(type, item), detail: itemDetail(type, item) }
}

export function projectTurn(method: string, params: Record<string, unknown>): CodexActivity | undefined {
  if (method === 'turn/plan/updated') {
    const plan = Array.isArray(params.plan) ? params.plan : []
    const lines = plan.map(step => isRecord(step) ? `- ${text(step.status) || 'pending'}: ${text(step.step)}` : '').filter(Boolean)
    return { id: 'turn-plan', kind: 'plan', status: 'updated', title: 'Codex 计划', detail: [text(params.explanation), ...lines].filter(Boolean).join('\n') }
  }
  if (method === 'turn/diff/updated') return { id: 'turn-diff', kind: 'diff', status: 'updated', title: '文件变更', detail: text(params.diff) }
  if (method === 'warning' || method === 'configWarning') return { id: method + ':' + text(params.message || params.summary), kind: 'warning', status: 'warning', title: 'Codex 警告', detail: text(params.message || params.summary) }
  if (method === 'error') {
    const error = isRecord(params.error) ? params.error : params
    return { id: 'turn-error', kind: 'error', status: 'failed', title: 'Codex 错误', detail: text(error.message) || safeJson(error) }
  }
  return
}

export function safeJson(value: unknown): string {
  return bound(JSON.stringify(redact(value)) ?? '')
}

export function bound(value: string): string {
  return value.length <= DETAIL_LIMIT ? value : value.slice(0, DETAIL_LIMIT) + '\n…'
}

function itemTitle(type: string, item: Record<string, unknown>): string {
  if (type === 'commandExecution') return text(item.command) || '命令'
  if (type === 'fileChange') return '文件变更'
  if (type === 'mcpToolCall') return [text(item.server), text(item.tool)].filter(Boolean).join(' / ') || 'MCP 工具'
  if (type === 'webSearch') return text(item.query) || '网页搜索'
  if (type === 'plan') return '计划'
  if (type === 'agentMessage') return text(item.phase) === 'commentary' ? '过程说明' : '回复'
  return type
}

function itemDetail(type: string, item: Record<string, unknown>): string {
  if (type === 'commandExecution') return bound([text(item.cwd), text(item.aggregatedOutput), text(item.exitCode) && 'exit ' + text(item.exitCode)].filter(Boolean).join('\n'))
  if (type === 'fileChange') return bound(changes(item.changes))
  if (type === 'reasoning') return bound(Array.isArray(item.summary) ? item.summary.map(text).filter(Boolean).join('\n') : text(item.summary))
  if (type === 'agentMessage' || type === 'plan') return bound(text(item.text))
  return bound(safeJson(item))
}

function changes(value: unknown): string {
  if (!Array.isArray(value)) return ''
  return value.map(change => isRecord(change) ? [text(change.kind), text(change.path), text(change.diff)].filter(Boolean).join('\n') : '').filter(Boolean).join('\n\n')
}

function redact(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redact)
  if (!isRecord(value)) return value
  return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, SECRET.test(key) ? '[redacted]' : redact(entry)]))
}

function finite(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined
}

function text(value: unknown): string {
  return typeof value === 'string' ? value : typeof value === 'number' ? String(value) : ''
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}
