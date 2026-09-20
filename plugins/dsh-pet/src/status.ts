/**
 * Aggregates DeepSeek Harness agent/session events into the pet display
 * snapshot (sprite animation + status bubble). The pet is a single
 * always-on-top window, so concurrent sessions reduce to the highest-priority
 * phase, mirroring Codex's task-state priority:
 *
 *   needs input (waiting) > blocked (error) > ready (review) > running
 *
 * `thinking` stays below `running`; `idle` is the floor.
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-tool-todo'
import type {} from '@deepseek-ai/dsh-user-questions'
import type {} from '@deepseek-ai/dsh-user-approval'
import { TASK_STATE_PRIORITY, type PetBubble, type PetDisplay, type PetState, type PetTask, type PetTaskState } from './shared/state.js'

type Phase = 'idle' | 'thinking' | 'working'

type CopyGroup =
  | 'idle' | 'preparing' | 'thinking'
  | 'searching' | 'editing' | 'testing' | 'commanding' | 'working' | 'result'
  | 'waiting' | 'approval' | 'success' | 'error' | 'stopped'

const COPY: Record<CopyGroup, readonly [string, string]> = {
  idle: ['暂无进行中的任务', '随时可以开始新任务'],
  preparing: ['正在理解任务和工作区', '正在准备本轮任务'],
  thinking: ['正在分析下一步', '正在梳理实现思路'],
  searching: ['正在查找文件和相关信息', '正在读取所需内容'],
  editing: ['正在修改文件', '正在写入本轮改动'],
  testing: ['正在运行检查', '正在验证改动结果'],
  commanding: ['正在执行终端命令', '正在运行项目命令'],
  working: ['正在调用工具处理任务', '正在继续执行任务'],
  result: ['正在读取结果并继续', '正在整理工具结果'],
  waiting: ['需要你回答后才能继续', '正在等待你的决定'],
  approval: ['需要你批准后才能继续', '正在等待操作授权'],
  success: ['结果已经就绪', '本轮任务已经完成'],
  error: ['任务没有完成', '执行过程中遇到问题'],
  stopped: ['任务已经停止', '本轮执行已中止'],
}

const STAGE: Record<CopyGroup, string> = {
  idle: '待命',
  preparing: '准备中',
  thinking: '思考中',
  searching: '查找中',
  editing: '编辑中',
  testing: '验证中',
  commanding: '执行中',
  working: '处理中',
  result: '整理中',
  waiting: '需要确认',
  approval: '等待审批',
  success: '已完成',
  error: '执行失败',
  stopped: '已停止',
}

const TITLE_MAX_LENGTH = 54
const SUMMARY_MAX_LENGTH = 92
const REFRESH_INTERVAL_MS = 10_000

function copyOf(group: CopyGroup, seed = 0): string {
  const variants = COPY[group]
  const n = Number.isFinite(seed) ? Math.abs(Math.trunc(seed)) : 0
  return variants[n % variants.length]!
}

type Activity = 'searching' | 'editing' | 'testing' | 'commanding' | 'using-tool'

export function toolActivity(name: string): Activity {
  const value = name.toLowerCase()
  if (/search|grep|find|glob|web|read|fetch|open/.test(value)) return 'searching'
  if (/write|edit|patch|replace|create|move|delete/.test(value)) return 'editing'
  if (/test|check|lint|build|verify/.test(value)) return 'testing'
  if (/shell|bash|exec|command|terminal|powershell/.test(value)) return 'commanding'
  return 'using-tool'
}

export function groupOf(activity: Activity): CopyGroup {
  switch (activity) {
    case 'searching': return 'searching'
    case 'editing': return 'editing'
    case 'testing': return 'testing'
    case 'commanding': return 'commanding'
    default: return 'working'
  }
}

/** Stage label shown for a task row, keyed by its lifecycle state. */
const TASK_STAGE: Record<PetTaskState, string> = {
  running: STAGE.working,
  waiting: STAGE.waiting,
  review: STAGE.success,
  failed: STAGE.error,
}

const TASK_ACTION: Record<PetTaskState, string> = {
  running: '查看进度',
  waiting: '去处理',
  review: '查看结果',
  failed: '查看原因',
}

/** Reduce one session record to its Codex task state (idle = not listed). */
function taskState(record: SessionRecord): PetTaskState | 'idle' {
  if (record.pending > 0) return 'waiting'
  if (record.sticky === 'failed') return 'failed'
  if (record.sticky === 'review') return 'review'
  if (record.phase === 'working' || record.phase === 'thinking') return 'running'
  return 'idle'
}

function cleanProjectName(value: string | undefined): string | undefined {
  const text = (value ?? '').trim()
  if (!text) return undefined
  const parts = text.split(/[\\/]/u).filter(Boolean)
  const candidate = parts.length > 1 ? parts[parts.length - 1]! : text
  return candidate.replace(/\s+/gu, ' ').slice(0, 40) || undefined
}

interface SessionRecord {
  id: string
  phase: Phase
  group: CopyGroup
  activity: Activity | undefined
  task: string | undefined
  /** Latest direct human prompt, kept stable while tools/todos change. */
  title: string | undefined
  progress: { completed: number; total: number } | undefined
  project: string | undefined
  openTools: number
  updatedAt: number
  /** Wall-clock start of the current turn, used for a useful running duration. */
  startedAtMs: number
  /** Wall-clock time the current lifecycle state began. */
  statusAtMs: number
  /** Number of open "needs input" holds (question/approval/blocked turn). */
  pending: number
  /** Stage shown while `pending > 0`: waiting or approval. */
  pendingGroup: CopyGroup
  /** Concrete question/approval reason shown while user action is required. */
  pendingSummary: string | undefined
  /** Sticky post-turn state: failed (blocked) or review (ready). */
  sticky: 'failed' | 'review' | undefined
  /** Bounded provider/system failure text shown instead of a generic error. */
  errorSummary: string | undefined
}

function boundText(value: string | undefined, maxLength: number): string | undefined {
  const text = (value ?? '')
    .replace(/```[\s\S]*?```/gu, ' ')
    .replace(/^[\s#>*_-]+/u, '')
    .replace(/\s+/gu, ' ')
    .trim()
  if (!text) return undefined
  return text.length <= maxLength ? text : `${text.slice(0, maxLength - 1).trimEnd()}…`
}

function userMessageTitle(event: Extract<SessionEvent, { type: 'user/message' }>): string | undefined {
  if (event.data.source.kind !== 'user') return undefined
  const text = event.data.content
    .filter(block => block.type === 'text')
    .map(block => block.text)
    .join(' ')
  return boundText(text, TITLE_MAX_LENGTH)
}

function formatDuration(milliseconds: number): string {
  const seconds = Math.max(0, Math.floor(milliseconds / 1000))
  if (seconds < 10) return '刚刚开始'
  if (seconds < 60) return `已运行 ${Math.floor(seconds / 10) * 10} 秒`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `已运行 ${minutes} 分钟`
  const hours = Math.floor(minutes / 60)
  const remainder = minutes % 60
  return remainder === 0 ? `已运行 ${hours} 小时` : `已运行 ${hours} 小时 ${remainder} 分钟`
}

function formatStatusAge(state: Exclude<PetTaskState, 'running'>, milliseconds: number): string {
  const minutes = Math.max(0, Math.floor(milliseconds / 60_000))
  const prefix = state === 'waiting' ? '已等待' : state === 'review' ? '完成' : '出错'
  if (minutes < 1) return state === 'waiting' ? '等待中' : `刚刚${prefix}`
  if (minutes < 60) return `${prefix} ${minutes} 分钟`
  const hours = Math.floor(minutes / 60)
  return `${prefix} ${hours} 小时`
}

/** Stable task title: latest human prompt, then current todo, project, id. */
function titleFor(record: SessionRecord): string {
  return record.title ?? boundText(record.task, TITLE_MAX_LENGTH) ?? record.project ?? record.id.slice(0, 8)
}

function summaryFor(record: SessionRecord, state: PetTaskState): string {
  if (state === 'waiting') {
    return record.pendingSummary ?? copyOf(record.pendingGroup, record.updatedAt)
  }
  if (state === 'failed') {
    return record.errorSummary ?? '任务没有完成，点击查看错误详情'
  }
  if (state === 'review') return '结果已就绪，点击打开会话查看'
  const task = boundText(record.task, SUMMARY_MAX_LENGTH)
  if (task !== undefined && task !== record.title) return `当前：${task}`
  return copyOf(record.group, record.updatedAt)
}

/** Metadata line for the task list, without repeating the title or summary. */
function rowDetailFor(record: SessionRecord, state: PetTaskState, now: number): string | undefined {
  const parts: string[] = []
  if (record.project && record.project !== titleFor(record)) parts.push(record.project)
  if (record.progress !== undefined && record.progress.total > 0) {
    parts.push(`${record.progress.completed}/${record.progress.total} 步`)
  }
  parts.push(state === 'running'
    ? formatDuration(now - record.startedAtMs)
    : formatStatusAge(state, now - record.statusAtMs))
  return parts.length > 0 ? parts.join(' · ') : undefined
}

type DisplayListener = (display: PetDisplay) => void

export class PetStatusTracker {
  private readonly records = new Map<string, SessionRecord>()
  private readonly listeners = new Set<DisplayListener>()
  private readonly disposers: Array<() => void> = []
  private pulseTimer: ReturnType<typeof setTimeout> | undefined
  private refreshTimer: ReturnType<typeof setInterval> | undefined
  private lastSignature = ''
  private clock = 0

  constructor(private readonly ctx: Context, private readonly now: () => number = Date.now) {}

  start(listener: DisplayListener): void {
    this.listeners.add(listener)
    const ctx = this.ctx

    const beginWait = (id: string | undefined, group: CopyGroup, summary?: string): (() => void) | undefined => {
      if (id === undefined) return undefined
      const record = this.record(id)
      record.pending++
      record.pendingGroup = group
      record.pendingSummary = boundText(summary, SUMMARY_MAX_LENGTH)
      record.statusAtMs = this.now()
      this.emit()
      return () => {
        record.pending = Math.max(0, record.pending - 1)
        if (record.pending === 0) record.pendingSummary = undefined
        record.statusAtMs = this.now()
        this.emit()
      }
    }

    this.disposers.push(
      ctx.on('agent/status', ({ agent, status }) => {
        const record = this.record(agent.id)
        const running = status === 'running'
        if (running && record.phase === 'idle') {
          this.update(record, 'thinking', 'thinking', undefined)
        } else if (!running && record.openTools === 0 && (record.phase === 'thinking' || record.phase === 'working')) {
          this.update(record, 'idle', 'idle', undefined)
        }
        this.emit()
      }),
    )

    this.disposers.push(
      ctx.on('agent/error', ({ agent }) => {
        const record = this.record(agent.id)
        record.sticky = 'failed'
        record.statusAtMs = this.now()
        this.update(record, 'idle', 'error', undefined)
        this.emit()
      }),
    )

    this.disposers.push(
      ctx.on('session/event', (session, event) => {
        this.handleEvent(session, event)
      }),
    )

    // Passthrough observers: mark waiting while a question/approval is open.
    this.disposers.push(
      ctx.on('user-questions/request', async (request, next) => {
        const summary = request.questions?.map(question => question.question).join('；')
        const endWait = beginWait(request.agent?.id, 'waiting', summary)
        try {
          return await next()
        } finally {
          endWait?.()
        }
      }),
    )

    this.disposers.push(
      ctx.on('approval/request', async (request, next) => {
        const summary = request.reason ?? `需要批准 ${request.toolName} 操作`
        const endWait = beginWait(request.agent?.id, 'approval', summary)
        try {
          return await next()
        } finally {
          endWait?.()
        }
      }),
    )

    this.refreshTimer = setInterval(() => {
      if (this.pulseTimer !== undefined) return
      if ([...this.records.values()].some(record => taskState(record) !== 'idle')) this.emit()
    }, REFRESH_INTERVAL_MS)
    this.refreshTimer.unref?.()

    this.emit()
  }

  currentDisplay(): PetDisplay {
    return this.compute()
  }

  dispose(): void {
    for (const disposer of this.disposers) disposer()
    this.disposers.length = 0
    this.listeners.clear()
    this.records.clear()
    if (this.pulseTimer !== undefined) clearTimeout(this.pulseTimer)
    this.pulseTimer = undefined
    if (this.refreshTimer !== undefined) clearInterval(this.refreshTimer)
    this.refreshTimer = undefined
  }

  /** Mark a completed result as seen after the user clicks its task row. */
  acknowledge(id: string): void {
    const record = this.records.get(id)
    if (record?.sticky !== 'review') return
    record.sticky = undefined
    record.statusAtMs = this.now()
    this.emit()
  }

  // MARK: session/event

  private handleEvent(session: Session, event: SessionEvent): void {
    const record = this.record(session.id)
    record.project = cleanProjectName(session.header.cwd) ?? record.project
    record.updatedAt = ++this.clock

    switch (event.type) {
      case 'turn/start':
        record.openTools = 0
        record.task = undefined
        record.progress = undefined
        // A new turn means the previous result was seen and any prior wait/error
        // is being retried — clear the sticky "ready"/"blocked" and pending holds.
        record.pending = 0
        record.pendingSummary = undefined
        record.sticky = undefined
        record.errorSummary = undefined
        record.startedAtMs = this.now()
        record.statusAtMs = record.startedAtMs
        this.update(record, 'thinking', 'preparing', undefined)
        this.emit()
        return

      case 'user/message': {
        const title = userMessageTitle(event)
        if (title !== undefined) record.title = title
        record.updatedAt = ++this.clock
        this.emit()
        return
      }

      case 'step/start':
      case 'assistant/message':
        if (record.openTools > 0) return
        if (record.phase === 'thinking' && record.group === 'thinking') return
        this.update(record, 'thinking', 'thinking', undefined)
        this.emit()
        return

      case 'tool/call': {
        record.openTools++
        const activity = toolActivity(event.data.name)
        this.update(record, 'working', groupOf(activity), activity)
        this.emit()
        return
      }

      case 'tool/result': {
        record.openTools = Math.max(0, record.openTools - 1)
        const nextPhase: Phase = record.openTools > 0 ? 'working' : 'thinking'
        const nextGroup: CopyGroup = record.openTools > 0 ? record.group : 'result'
        this.update(record, nextPhase, nextGroup, undefined)
        if (event.data.error !== undefined) {
          this.emitErrorPulse(record)
        } else {
          this.emit()
        }
        return
      }

      case 'todo/write': {
        const todos = event.data.todos
        const completed = todos.filter(todo => todo.status === 'completed').length
        const current = todos.find(todo => todo.status === 'in_progress') ?? todos.find(todo => todo.status === 'pending')
        record.progress = { completed, total: todos.length }
        if (current !== undefined) record.task = current.content
        record.updatedAt = ++this.clock
        this.emit()
        return
      }

      case 'turn/end': {
        const kind = event.data.reason.kind
        record.openTools = 0
        switch (kind) {
          case 'blocked':
            // Codex "Needs input": the turn stopped waiting on the user.
            record.pending++
            record.pendingGroup = 'waiting'
            record.pendingSummary ??= '需要你的输入后才能继续'
            record.statusAtMs = this.now()
            this.update(record, 'idle', 'waiting', undefined)
            this.emit()
            return
          case 'aborted':
          case 'interrupted':
          case 'max-tokens':
            this.update(record, 'idle', 'stopped', undefined)
            this.emitStoppedPulse(record)
            return
          case 'error':
            // Codex "Blocked": the turn failed and is surfaced until retried.
            record.sticky = 'failed'
            record.errorSummary = boundText(event.data.reason.error?.message, SUMMARY_MAX_LENGTH)
            record.statusAtMs = this.now()
            this.update(record, 'idle', 'error', undefined)
            this.emit()
            return
          default:
            // Codex "Ready": the turn finished with output the user has not
            // yet reviewed. The task holds the review state until the next turn.
            record.sticky = 'review'
            record.statusAtMs = this.now()
            this.update(record, 'idle', 'success', undefined)
            this.emit()
            return
        }
      }

      default:
        return
    }
  }

  // MARK: internals

  private record(id: string): SessionRecord {
    let record = this.records.get(id)
    if (record === undefined) {
      const now = this.now()
      record = {
        id,
        phase: 'idle',
        group: 'idle',
        activity: undefined,
        task: undefined,
        title: undefined,
        progress: undefined,
        project: undefined,
        openTools: 0,
        updatedAt: ++this.clock,
        startedAtMs: now,
        statusAtMs: now,
        pending: 0,
        pendingGroup: 'waiting',
        pendingSummary: undefined,
        sticky: undefined,
        errorSummary: undefined,
      }
      this.records.set(id, record)
    }
    return record
  }

  private update(record: SessionRecord, phase: Phase, group: CopyGroup, activity: Activity | undefined): void {
    record.phase = phase
    record.group = group
    record.activity = activity
    record.updatedAt = ++this.clock
  }

  private emit(): void {
    this.clearPulse()
    const display = this.compute()
    const signature = JSON.stringify(display)
    if (signature === this.lastSignature) return
    this.lastSignature = signature
    for (const listener of this.listeners) listener(display)
  }

  private emitErrorPulse(record: SessionRecord): void {
    const display = this.compute()
    this.emitPulse({ ...display, state: 'failed', bubble: this.bubbleFor('error', record, true) })
  }

  private emitStoppedPulse(record: SessionRecord): void {
    const display = this.compute()
    this.emitPulse({ ...display, state: 'idle', bubble: this.bubbleFor('stopped', record, true) })
  }

  private emitPulse(display: PetDisplay): void {
    this.clearPulse()
    this.lastSignature = JSON.stringify(display)
    for (const listener of this.listeners) listener(display)
    this.pulseTimer = setTimeout(() => {
      this.pulseTimer = undefined
      this.lastSignature = ''
      this.emit()
    }, 2200)
  }

  private clearPulse(): void {
    if (this.pulseTimer !== undefined) {
      clearTimeout(this.pulseTimer)
      this.pulseTimer = undefined
    }
  }

  private bubbleFor(group: CopyGroup, record: SessionRecord, pulse: boolean): PetBubble {
    const bubble: PetBubble = {
      stage: STAGE[group],
      message: copyOf(group, record.updatedAt),
    }
    const detail = [
      record.project,
      record.progress !== undefined && record.progress.total > 0
        ? `${record.progress.completed}/${record.progress.total} 步`
        : undefined,
      boundText(record.task, 48),
    ].filter((part): part is string => part !== undefined).join(' · ')
    if (detail) bubble.detail = detail
    if (pulse) {
      bubble.pulse = true
      bubble.ttlMs = 2200
    }
    return bubble
  }

  private compute(): PetDisplay {
    // Collect every active session as one task row, ordered by Codex priority:
    // Needs input > Blocked > Ready > Running, ties broken by recency.
    const entries: Array<{ record: SessionRecord; state: PetTaskState }> = []
    for (const record of this.records.values()) {
      const state = taskState(record)
      if (state === 'idle') continue
      entries.push({ record, state })
    }
    entries.sort((a, b) => {
      const delta = TASK_STATE_PRIORITY[b.state] - TASK_STATE_PRIORITY[a.state]
      if (delta !== 0) return delta
      return b.record.updatedAt - a.record.updatedAt
    })
    const top = entries[0]
    const now = this.now()
    const tasks: PetTask[] = entries.map(({ record, state }) => {
      const task: PetTask = {
        id: record.id,
        title: titleFor(record),
        state,
        stage: state === 'running' ? STAGE[record.group] : TASK_STAGE[state],
        summary: summaryFor(record, state),
        action: TASK_ACTION[state],
      }
      const detail = rowDetailFor(record, state, now)
      if (detail !== undefined) task.detail = detail
      return task
    })
    const state: PetState = top?.state ?? 'idle'
    // Keep the pet quiet at rest. Active work uses the richer task panel, while
    // `bubble` remains reserved for short exceptional pulses.
    const bubble: PetBubble | null = null
    return { state, bubble, tasks }
  }
}
