import { mkdir, readFile, rename, writeFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { Run, Fields, WorkspaceError, type BoundRequest, type Observation, type SubmitRequest } from './contract.js'

const active = new Set<Run['status']>(['awaiting_input', 'awaiting_login', 'queued', 'running'])
type Enqueue = (sessionId: string, requestId: string, runId: string) => Promise<void>
export class RunStore {
  private runs: Run[] = []
  private durable: Run[] = []
  private lane: Promise<unknown> = Promise.resolve()
  private stopped = false
  private constructor(private readonly directory: string) {}
  static async open(directory: string): Promise<RunStore> {
    const store = new RunStore(directory)
    await mkdir(directory, { recursive: true, mode: 0o700 })
    try { store.runs = z.array(Run).max(100).parse(JSON.parse(await readFile(join(directory, 'runs.json'), 'utf8'))) }
    catch (error) { if (!(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT')) throw error }
    for (const run of store.runs) {
      if (active.has(run.status)) { run.status = 'interrupted'; run.revision++; run.updatedAt = new Date().toISOString() }
    }
    await store.save()
    return store
  }
  private async save(): Promise<void> {
    const temp = join(this.directory, `runs-${randomUUID()}.tmp`)
    try {
      await writeFile(temp, JSON.stringify(this.runs), { mode: 0o600 })
      await rename(temp, join(this.directory, 'runs.json'))
      this.durable = structuredClone(this.runs)
    } finally { await rm(temp, { force: true }).catch(() => {}) }
  }
  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.lane.then(async () => {
      if (this.stopped) throw new WorkspaceError('stopped')
      try { return await fn() }
      catch (error) { this.runs = structuredClone(this.durable); throw error }
    })
    this.lane = next.catch(() => {})
    return next
  }
  private own(sessionId: string, id: string): Run {
    const run = this.runs.find(run => run.id === id && run.sessionId === sessionId)
    if (!run) throw new WorkspaceError('not-found')
    return run
  }
  private bound(request: BoundRequest): Run {
    const run = this.own(request.sessionId, request.runId)
    if (run.revision !== request.revision) throw new WorkspaceError('stale-input')
    return run
  }
  private available(except?: string): void {
    if (this.runs.some(run => run.id !== except && active.has(run.status))) throw new WorkspaceError('task-busy')
  }
  private async commit(run: Run): Promise<Run> {
    run.revision++; run.updatedAt = new Date().toISOString()
    Run.parse(run)
    await this.save()
    return structuredClone(run)
  }
  latest(sessionId: string): Run | null { return structuredClone(this.runs.find(run => run.sessionId === sessionId) ?? null) }
  get(sessionId: string, runId: string): Run { return structuredClone(this.own(sessionId, runId)) }
  showLogin(request: BoundRequest, show: () => Promise<void>): Promise<Run> {
    return this.serial(async () => {
      const run = this.bound(request)
      if (run.status !== 'awaiting_login') throw new WorkspaceError('stale-input')
      await show()
      return structuredClone(run)
    })
  }
  create(sessionId: string, siteName: string, fields?: Fields): Promise<Run> {
    return this.serial(async () => {
      this.available()
      if (this.runs.length >= 100) throw new WorkspaceError('history-full')
      const time = new Date().toISOString()
      const run: Run = { id: randomUUID(), sessionId, siteName, revision: 1, status: fields ? 'queued' : 'awaiting_input', createdAt: time, updatedAt: time,
        input: { id: randomUUID(), fields: Fields.parse(fields ?? { keyword: '', view: 'table' }), submitted: !!fields, accepted: !!fields } }
      this.runs.unshift(run); await this.save(); return structuredClone(run)
    })
  }
  submit(request: SubmitRequest, enqueue: Enqueue): Promise<Run> {
    return this.serial(async () => {
      const run = this.own(request.sessionId, request.runId)
      if (run.input.id !== request.inputId) throw new WorkspaceError('stale-input')
      if (run.input.submitted) {
        if (JSON.stringify(run.input.fields) !== JSON.stringify(request.fields)) throw new WorkspaceError('stale-input')
        if (run.input.accepted) return structuredClone(run)
        if (run.status !== 'queued') throw new WorkspaceError('stale-input')
      } else {
        this.bound(request)
        if (run.status !== 'awaiting_input') throw new WorkspaceError('stale-input')
        this.available(run.id)
        run.input.fields = request.fields; run.input.submitted = true; run.input.requestId = randomUUID(); run.status = 'queued'
        await this.commit(run)
      }
      // Persist the id before queue admission; a lost receipt retries the exact same native request.
      await enqueue(run.sessionId, run.input.requestId!, run.id)
      run.input.accepted = true
      return this.commit(run)
    })
  }
  edit(request: BoundRequest): Promise<Run> {
    return this.serial(async () => {
      const run = this.bound(request); this.available(run.id)
      if (['running', 'queued', 'awaiting_login'].includes(run.status)) throw new WorkspaceError('task-busy')
      run.input = { id: randomUUID(), fields: run.input.fields, submitted: false, accepted: false }
      run.status = 'awaiting_input'; delete run.error
      return this.commit(run)
    })
  }
  resume(request: BoundRequest, enqueue: Enqueue): Promise<Run> {
    return this.serial(async () => {
      const run = this.bound(request); this.available(run.id)
      if (!['awaiting_login', 'interrupted', 'failed'].includes(run.status)) throw new WorkspaceError('stale-input')
      run.input.requestId = randomUUID(); run.input.submitted = true; run.input.accepted = false; run.status = 'queued'; delete run.error
      await this.commit(run)
      await enqueue(run.sessionId, run.input.requestId, run.id)
      run.input.accepted = true
      return this.commit(run)
    })
  }
  start(sessionId: string, runId: string): Promise<Run> {
    return this.serial(async () => {
      const run = this.own(sessionId, runId)
      if (run.status !== 'queued' || !run.input.submitted) throw new WorkspaceError('stale-input')
      this.available(run.id); run.status = 'running'; delete run.error
      return this.commit(run)
    })
  }
  finish(sessionId: string, runId: string, result: Observation | 'awaiting_login' | 'failed', error?: string): Promise<Run> {
    return this.serial(async () => {
      const run = this.own(sessionId, runId)
      if (run.status === 'cancelled') return structuredClone(run)
      if (run.status !== 'running') throw new WorkspaceError('stale-input')
      if (typeof result === 'string') { run.status = result; if (error) run.error = error }
      else { run.observation = result; run.status = result.truncated ? 'partial' : 'succeeded' }
      return this.commit(run)
    })
  }
  cancel(request: BoundRequest): Promise<Run> {
    return this.serial(async () => { const run = this.bound(request); run.status = 'cancelled'; return this.commit(run) })
  }
  async close(): Promise<void> { await this.lane; this.stopped = true }
}
