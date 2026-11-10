import { randomUUID } from 'node:crypto'
import { WorkspaceError, type Task, type TaskPhase } from './types.js'

/** Keep long commands outside HTTP response lifetimes, with bounded history. */
export class Tasks {
  private readonly entries = new Map<string, { task: Task; abort: AbortController; done: Promise<void> }>()
  private stopped = false
  list(): Task[] { return [...this.entries.values()].map(entry => ({ ...entry.task })) }
  start(fullName: string, kind: Task['kind'], work: (signal: AbortSignal, report: (phase: TaskPhase, progress?: number) => void) => Promise<unknown>): Task {
    if (this.stopped) throw new WorkspaceError('stopped')
    const existing = [...this.entries.values()].find(entry => entry.task.fullName.toLowerCase() === fullName.toLowerCase() && ['running', 'cancelling'].includes(entry.task.status))
    if (existing) {
      if (existing.task.kind !== kind) throw new WorkspaceError('busy')
      return { ...existing.task }
    }
    const finished = [...this.entries.values()].filter(entry => !['running', 'cancelling'].includes(entry.task.status))
    while (this.entries.size >= 30 && finished.length) this.entries.delete(finished.shift()!.task.id)
    if (this.entries.size >= 30) throw new WorkspaceError('busy')
    const task: Task = { id: randomUUID(), fullName, kind, status: 'running', phase: 'checking', startedAt: Date.now() }
    const abort = new AbortController()
    const done = Promise.resolve().then(() => {
      abort.signal.throwIfAborted()
      return work(abort.signal, (phase, progress) => {
      task.phase = phase; delete task.progress
      if (progress !== undefined && Number.isFinite(progress)) task.progress = Math.max(0, Math.min(100, progress))
      })
    }).then(() => {
      task.status = abort.signal.aborted ? 'cancelled' : 'complete'
      if (task.status === 'complete') task.phase = 'complete'
    }, error => {
      task.status = abort.signal.aborted ? 'cancelled' : 'failed'
      if (task.status === 'failed') task.error = error instanceof WorkspaceError ? error.code : 'commandFailed'
    }).finally(() => { task.finishedAt = Date.now() })
    this.entries.set(task.id, { task, abort, done })
    return { ...task }
  }
  cancel(id: string): Task {
    const entry = this.entries.get(id)
    if (!entry) throw new WorkspaceError('invalidRequest')
    if (entry.task.status === 'running') { entry.task.status = 'cancelling'; entry.abort.abort() }
    return { ...entry.task }
  }
  async stop(): Promise<void> {
    this.stopped = true
    for (const entry of this.entries.values()) if (entry.task.status === 'running') this.cancel(entry.task.id)
    await Promise.allSettled([...this.entries.values()].map(entry => entry.done))
  }
  async cancelSync(fullName: string): Promise<void> {
    const entry = [...this.entries.values()].find(entry => entry.task.fullName.toLowerCase() === fullName.toLowerCase() && entry.task.kind === 'sync' && ['running', 'cancelling'].includes(entry.task.status))
    if (entry) { this.cancel(entry.task.id); await entry.done }
  }
}
