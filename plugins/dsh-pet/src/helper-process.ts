/**
 * Owns the spawned native Helper process: pipes stdio, parses inbound
 * newline-delimited JSON messages, and reports lifecycle. A crashed helper is
 * restarted by the caller (not here) so the restart policy stays in one place.
 */

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { assertCompanionMessage, createMessage, encodeMessage, type CompanionMessage, type MessageKind } from './protocol.js'

export interface HelperProcessOptions {
  binaryPath: string
  onMessage: (message: CompanionMessage) => void
  onError: (error: Error) => void
  onExit: (code: number | null, signal: NodeJS.Signals | null) => void
  onStderr: (line: string) => void
}

export class HelperProcess {
  private child: ChildProcessWithoutNullStreams | undefined
  private buffer = ''
  private stopped = false
  private stopping: Promise<void> | undefined

  constructor(private readonly options: HelperProcessOptions) {}

  get running(): boolean {
    return this.child !== undefined && this.child.exitCode === null && this.child.signalCode === null
  }

  start(): void {
    this.stopped = false
    this.stopping = undefined
    this.buffer = ''
    let child: ChildProcessWithoutNullStreams
    try {
      child = spawn(this.options.binaryPath, [], { stdio: ['pipe', 'pipe', 'pipe'] })
    } catch (error) {
      this.options.onError(error instanceof Error ? error : new Error(String(error)))
      return
    }
    this.child = child

    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => this.ingest(chunk))
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk: string) => {
      for (const line of chunk.split('\n')) {
        const trimmed = line.trim()
        if (trimmed !== '') this.options.onStderr(trimmed)
      }
    })
    child.on('error', error => this.options.onError(error))
    child.on('exit', (code, signal) => {
      if (this.child === child) this.child = undefined
      if (!this.stopped) this.options.onExit(code, signal)
    })
  }

  private ingest(chunk: string): void {
    this.buffer += chunk
    let newline = this.buffer.indexOf('\n')
    while (newline >= 0) {
      const line = this.buffer.slice(0, newline)
      this.buffer = this.buffer.slice(newline + 1)
      newline = this.buffer.indexOf('\n')
      if (line.trim() === '') continue
      try {
        const message = assertCompanionMessage(JSON.parse(line))
        if (message !== null) this.options.onMessage(message)
      } catch {
        // Ignore malformed lines; the helper is untrusted input.
      }
    }
  }

  send(kind: MessageKind, payload: Record<string, unknown> = {}): boolean {
    if (this.child === undefined || this.child.stdin.destroyed) return false
    this.child.stdin.write(encodeMessage(createMessage(kind, payload)))
    return true
  }

  /**
   * Ask the Helper to shut down and wait until its stdio has closed. Waiting
   * for `close` (rather than only `exit`) guarantees that the final `move`
   * snapshot emitted before `closed` has reached the host.
   */
  stop(): Promise<void> {
    if (this.stopping !== undefined) return this.stopping
    this.stopped = true
    const child = this.child
    if (child === undefined) return Promise.resolve()

    this.stopping = new Promise(resolve => {
      let finished = false
      let forceTimer: NodeJS.Timeout | undefined
      let settleTimer: NodeJS.Timeout | undefined
      const finish = (): void => {
        if (finished) return
        finished = true
        if (forceTimer !== undefined) clearTimeout(forceTimer)
        if (settleTimer !== undefined) clearTimeout(settleTimer)
        resolve()
      }

      child.once('close', finish)
      this.send('shutdown')

      forceTimer = setTimeout(() => {
        try {
          child.kill('SIGTERM')
        } catch {
          // Already gone.
        }
      }, 1500)
      // Never leave plugin disposal hanging if an unhealthy child neither
      // exits nor closes its inherited pipes after SIGTERM.
      settleTimer = setTimeout(finish, 2500)
    })
    return this.stopping
  }
}
