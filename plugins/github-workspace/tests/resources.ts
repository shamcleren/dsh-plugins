import { execute, type CommandOptions, type Execute } from '../src/process.js'
import { WorkspaceError } from '../src/types.js'

/** Join fixture setup and child processes before disposing their directories. */
export class TestResources {
  private readonly abort = new AbortController()
  private readonly pending = new Set<Promise<unknown>>()
  private readonly disposers: Array<() => Promise<unknown>> = []
  private closing: Promise<void> | undefined
  readonly signal: AbortSignal

  constructor(signal: AbortSignal) { this.signal = AbortSignal.any([signal, this.abort.signal]) }

  run<T>(work: (signal: AbortSignal) => Promise<T>): Promise<T> {
    if (this.signal.aborted) return Promise.reject(new WorkspaceError('stopped'))
    const task = Promise.resolve().then(() => {
      if (this.signal.aborted) throw new WorkspaceError('stopped')
      return work(this.signal)
    })
    this.pending.add(task)
    void task.then(() => this.pending.delete(task), () => this.pending.delete(task))
    return task
  }

  readonly execute: Execute = (command, args, options: CommandOptions = {}) => this.run(signal =>
    execute(command, args, { ...options,
      signal: options.signal === undefined ? signal : AbortSignal.any([signal, options.signal]) }))

  defer(dispose: () => Promise<unknown>): void { this.disposers.push(dispose) }

  close(): Promise<void> { return this.closing ??= this.dispose() }

  private async dispose(): Promise<void> {
    this.abort.abort()
    while (this.pending.size) await Promise.allSettled([...this.pending])
    const errors: unknown[] = []
    for (const dispose of this.disposers.reverse()) {
      try { await dispose() } catch (error) { errors.push(error) }
    }
    this.disposers.length = 0
    if (errors.length) throw new AggregateError(errors, 'Fixture cleanup failed')
  }
}
