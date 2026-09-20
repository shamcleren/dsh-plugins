import { mkdtemp, readFile } from 'node:fs/promises'
import { createInterface } from 'node:readline'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AccountQuota } from '../src/account-quota.ts'
import { CodexBridge, type BridgeHost } from '../src/bridge.ts'
import type { CodexChild } from '../src/connection.ts'
import { readRecord } from '../src/journal.ts'

function limits(usedPercent: number) {
  return { rateLimits: { primary: { usedPercent, resetsAt: 1_700_000_000, windowDurationMins: 300 } } }
}

function quotaProcess(result: unknown, fail = false): CodexChild & { terminated: () => boolean } {
  const stdin = new PassThrough()
  const stdout = new PassThrough()
  const stderr = new PassThrough()
  let terminated = false
  const done = Promise.withResolvers<{ exitCode: number | null; signal: NodeJS.Signals | null }>()
  const lines = createInterface({ input: stdin })
  lines.on('line', line => {
    const frame = JSON.parse(line) as { id?: number; method?: string }
    if (frame.method === 'initialized' || typeof frame.id !== 'number') return
    if (fail && frame.method === 'account/rateLimits/read') {
      stdout.write(JSON.stringify({ jsonrpc: '2.0', id: frame.id, error: { message: 'unavailable' } }) + '\n')
      return
    }
    const payload = frame.method === 'account/rateLimits/read' ? result : { userAgent: 'fake' }
    stdout.write(JSON.stringify({ jsonrpc: '2.0', id: frame.id, result: payload }) + '\n')
  })
  return {
    stdin, stdout, stderr, done: done.promise, terminated: () => terminated,
    terminate() { terminated = true; done.resolve({ exitCode: null, signal: 'SIGTERM' }) },
    async waitForExit() { return terminated },
  }
}

describe('account quota', () => {
  const stops: Array<() => void> = []
  afterEach(() => { while (stops.length) stops.pop()?.() })

  it('keeps one snapshot, refreshes it, and reloads the last good value', async () => {
    const root = await mkdtemp(join(tmpdir(), 'codex-quota-'))
    const quota = new AccountQuota(root)
    quota.observe(limits(11))
    expect(quota.snapshot()).toEqual({ remaining: 89, resetsAt: 1_700_000_000_000, windowMinutes: 300 })
    quota.observe({ rateLimits: { credits: { balance: 1 } } })
    expect(quota.snapshot()?.remaining).toBe(89)
    await vi.waitFor(async () => {
      expect(JSON.parse(await readFile(join(root, 'account', 'quota.json'), 'utf8')).remaining).toBe(89)
    })

    const restored = new AccountQuota(root)
    let release = () => {}
    const gate = new Promise<void>(resolve => { release = resolve })
    let reads = 0
    const stop = restored.start({
      intervalMs: 60_000,
      readLive: async () => {
        reads += 1
        await gate
        return limits(20)
      },
      spawn: () => undefined,
    })
    stops.push(stop)
    await vi.waitFor(() => { expect(restored.snapshot()?.remaining).toBe(89) })
    release()
    await vi.waitFor(() => { expect(restored.snapshot()?.remaining).toBe(80) })
    expect(reads).toBe(1)
    stop()
    restored.kick()
    expect(restored.snapshot()?.remaining).toBe(80)
  })

  it('uses a short probe when no session connection is open and keeps the previous value if it fails', async () => {
    const root = await mkdtemp(join(tmpdir(), 'codex-quota-'))
    const quota = new AccountQuota(root)
    quota.observe(limits(11))
    let failed: ReturnType<typeof quotaProcess> | undefined
    const started = quota.start({
      intervalMs: 60_000,
      readLive: async () => undefined,
      spawn: () => () => (failed = quotaProcess(limits(40), true)),
    })
    stops.push(started)
    await vi.waitFor(() => { expect(failed?.terminated()).toBe(true) })
    expect(quota.snapshot()?.remaining).toBe(89)
    started()

    const next = new AccountQuota(root)
    let opened: ReturnType<typeof quotaProcess> | undefined
    const ok = next.start({
      intervalMs: 60_000,
      readLive: async () => undefined,
      spawn: () => () => (opened = quotaProcess(limits(40))),
    })
    stops.push(ok)
    await vi.waitFor(() => { expect(next.snapshot()?.remaining).toBe(60) })
    expect(opened?.terminated()).toBe(true)
  })

  it('publishes one account snapshot to every session instead of the session file', async () => {
    const root = await mkdtemp(join(tmpdir(), 'codex-quota-'))
    const account = new AccountQuota(root)
    const noted: Array<Record<string, unknown>> = []
    const host: BridgeHost = {
      root,
      spawn: () => server(),
      session: () => undefined,
      agent: () => undefined,
      approve: async () => 'rejected',
      saveImage: async () => ({ attachmentId: 'unused' as never, mediaType: 'image/png', bytes: 8, width: 1, height: 1 }),
      imageInput: async () => ({ type: 'localImage', path: '/stored/input.png' }),
      noteQuota: params => { noted.push(params); account.observe(params) },
    }
    const bridge = new CodexBridge(host)
    await bridge.run({ sessionId: 'alpha', cwd: '/work', text: 'one', signal: new AbortController().signal, onChunk: () => {} })
    await bridge.run({ sessionId: 'beta', cwd: '/work', text: 'two', signal: new AbortController().signal, onChunk: () => {} })
    expect(account.snapshot()?.remaining).toBe(89)
    expect((await readRecord(root, 'alpha'))?.quota).toBeUndefined()
    expect((await readRecord(root, 'beta'))?.quota).toBeUndefined()
    expect(noted.length).toBeGreaterThan(0)
    await bridge.close()
  })
})

function server(): CodexChild {
  const stdin = new PassThrough()
  const stdout = new PassThrough()
  const done = Promise.withResolvers<{ exitCode: number | null; signal: NodeJS.Signals | null }>()
  const lines = createInterface({ input: stdin })
  lines.on('line', line => {
    const frame = JSON.parse(line) as { id?: string; method?: string }
    const reply = (result: unknown) => stdout.write(JSON.stringify({ id: frame.id, result }) + '\n')
    if (frame.method === 'initialize') reply({ userAgent: 'fake' })
    else if (frame.method === 'thread/start' || frame.method === 'thread/resume') reply({ thread: { id: 'thread-shared' } })
    else if (frame.method === 'account/rateLimits/read') reply(limits(11))
    else if (frame.method === 'turn/start') {
      reply({ turn: { id: 'turn' } })
      stdout.write(JSON.stringify({ method: 'account/rateLimits/updated', params: limits(11) }) + '\n')
      stdout.write(JSON.stringify({ method: 'turn/completed', params: { turn: { status: 'completed' } } }) + '\n')
    } else if (frame.id !== undefined) reply({})
  })
  return { stdin, stdout, done: done.promise, terminate() { done.resolve({ exitCode: null, signal: 'SIGTERM' }) }, async waitForExit() { return true } }
}
