import { createInterface } from 'node:readline'
import { PassThrough } from 'node:stream'
import { describe, expect, it } from 'vitest'
import { CodexConnection, type CodexChild } from '../src/connection.ts'

interface Script {
  onTurn?: (notify: (method: string, params: object) => void, request: (method: string, params: object) => Promise<unknown>) => Promise<void>
  resumeFails?: boolean
}

function fakeServer(script: Script = {}): CodexChild & { terminated: () => boolean; frames: Array<Record<string, unknown>> } {
  const stdin = new PassThrough()
  const stdout = new PassThrough()
  const stderr = new PassThrough()
  const frames: Array<Record<string, unknown>> = []
  let terminated = false
  const done = Promise.withResolvers<{ exitCode: number | null; signal: NodeJS.Signals | null }>()
  const lines = createInterface({ input: stdin })
  lines.on('line', line => {
    const frame = JSON.parse(line) as Record<string, unknown>
    frames.push(frame)
    const reply = (result: unknown): void => { stdout.write(JSON.stringify({ jsonrpc: '2.0', id: frame.id, result }) + '\n') }
    if (frame.method === 'initialize') reply({ userAgent: 'fake' })
    else if (frame.method === 'thread/resume' && script.resumeFails) stdout.write(JSON.stringify({ jsonrpc: '2.0', id: frame.id, error: { code: -32000, message: 'missing thread' } }) + '\n')
    else if (frame.method === 'thread/start' || frame.method === 'thread/resume') reply({ thread: { id: frame.method === 'thread/resume' ? 'thread-old' : 'thread-new' } })
    else if (frame.method === 'turn/start') {
      reply({ turn: { id: 'turn-1' } })
      const notify = (method: string, params: object) => { stdout.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n') }
      const request = (method: string, params: object) => new Promise(resolve => {
        const id = 'server-' + method
        const wait = createInterface({ input: stdin })
        const onLine = (next: string) => {
          const response = JSON.parse(next) as { id?: string; result?: unknown }
          if (response.id !== id) return
          wait.close()
          resolve(response.result)
        }
        wait.on('line', onLine)
        stdout.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n')
      })
      void (script.onTurn ?? (async emit => {
        emit('item/agentMessage/delta', { delta: 'hello' })
        emit('item/completed', { item: { type: 'imageGeneration', id: 'image-1', status: 'completed', result: 'sensitive-base64' } })
        emit('item/started', { item: { id: 'cmd-1', type: 'commandExecution', command: 'ls', status: 'inProgress' } })
        emit('item/completed', { item: { id: 'cmd-1', type: 'commandExecution', command: 'ls', aggregatedOutput: 'a.txt', status: 'completed' } })
        emit('unknown/noise', { secret: 'nope' })
        emit('turn/completed', { turn: { id: 'turn-1', status: 'completed' } })
      }))(notify, request)
    } else if (frame.method === 'turn/interrupt') {
      reply({})
      stdout.write(JSON.stringify({ jsonrpc: '2.0', method: 'turn/completed', params: { turn: { id: 'turn-1', status: 'interrupted' } } }) + '\n')
    }
  })
  return {
    stdin, stdout, stderr, frames, done: done.promise, terminated: () => terminated,
    terminate() { terminated = true; done.resolve({ exitCode: null, signal: 'SIGTERM' }) },
    async waitForExit() { return terminated },
  }
}

describe('Codex app-server client', () => {
  it('handshakes, resumes or starts a thread, and projects a turn', async () => {
    const child = fakeServer()
    const notes: string[] = []
    const connection = new CodexConnection(child, async () => ({}), (method, params) => { notes.push(method + ':' + JSON.stringify(params.delta ?? params.item ?? '')) })
    connection.start()
    const signal = AbortSignal.timeout(2000)
    await connection.initialize(signal)
    expect(await connection.openThread('/work', 'gpt-5.5', 'thread-old', signal, 'high')).toBe('thread-old')
    const started = child.frames.find(frame => frame.method === 'thread/resume')
    expect(started?.params).toMatchObject({ model: 'gpt-5.5', config: { model_reasoning_effort: 'high' } })
    const end = await connection.turn([{ type: 'text', text: 'ping', text_elements: [] }], signal)
    expect(end.status).toBe('completed')
    expect(notes.some(note => note.includes('hello'))).toBe(true)
    expect(connection.notifications.some(note => note.method === 'unknown/noise')).toBe(true)
    expect(JSON.stringify(connection.notifications)).not.toContain('sensitive-base64')
    await connection.dispose()
    expect(child.terminated()).toBe(true)
  })

  it('starts a new thread when resume fails and cancels an in-flight turn', async () => {
    const lost = fakeServer({ resumeFails: true })
    const connection = new CodexConnection(lost, async () => ({}), () => {})
    connection.start()
    const signal = AbortSignal.timeout(2000)
    await connection.initialize(signal)
    expect(await connection.openThread('/work', undefined, 'missing', signal)).toBe('thread-new')
    await connection.dispose()

    const running = fakeServer({ onTurn: async () => new Promise(() => {}) })
    const cancelled = new CodexConnection(running, async () => ({}), () => {})
    cancelled.start()
    const turnSignal = AbortSignal.timeout(2000)
    await cancelled.initialize(turnSignal)
    await cancelled.openThread('/work', undefined, undefined, turnSignal)
    const pending = cancelled.turn([{ type: 'text', text: 'stop me', text_elements: [] }], turnSignal)
    await new Promise(resolve => setTimeout(resolve, 20))
    cancelled.interrupt()
    expect((await pending).status).toBe('interrupted')
    await cancelled.dispose()
  })

  it('returns the DSH decision without a session-wide grant', async () => {
    let decision = ''
    const child = fakeServer({
      onTurn: async (_notify, request) => {
        const result = await request('item/commandExecution/requestApproval', { command: 'rm -rf /' }) as { decision?: string }
        decision = result.decision ?? ''
        _notify('turn/completed', { turn: { id: 'turn-1', status: 'completed' } })
      },
    })
    const connection = new CodexConnection(child, async () => ({ decision: 'decline' }), () => {})
    connection.start()
    const signal = AbortSignal.timeout(2000)
    await connection.initialize(signal)
    await connection.openThread('/work', undefined, undefined, signal)
    await connection.turn([{ type: 'text', text: 'need approval', text_elements: [] }], signal)
    expect(decision).toBe('decline')
    expect(JSON.stringify(child.frames)).not.toContain('acceptForSession')
    await connection.dispose()
  })
})
