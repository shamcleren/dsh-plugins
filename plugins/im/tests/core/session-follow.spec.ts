import { Context } from '@deepseek-ai/cordis'
import { expect, it, vi } from 'vitest'
import { createHostApi, type HostApiProxy } from '../../src/core/host-api.js'

const record = (seq: number) => ({ type: 'event' as const, event: { type: 'fixture/event', seq, time: 0, data: {} } })

it('pages the opening journal back to the requested cut and deduplicates subsequent events', async () => {
  const ctx = new Context()
  const page = vi.fn(async ({ beforeSeq }: { beforeSeq: number }) => ({
    records: beforeSeq === 8 ? [record(6), record(7)] : [record(4), record(5)], hasMore: true,
  }))
  const follow = vi.fn(async function* () {
    yield { type: 'snapshot', cursor: 9, records: [record(8), record(9)], hasMore: true }
    yield record(9)
    yield record(10)
  })
  ctx.provide('sessionController', { follow, page } as never)
  ctx.provide('workspaceRegistry', {} as never)
  let api!: HostApiProxy
  await ctx.plugin({ apply(inner: Context) { api = createHostApi(inner, () => true) } })
  try {
    const events = []
    for await (const event of api.sessions.follow!({ rpcId: 'follow', payload: { sessionId: 'owned', afterSeq: 4 } }, new AbortController().signal)) events.push(event.seq)
    expect(events).toEqual([5, 6, 7, 8, 9, 10])
    expect(page.mock.calls.map(([request]) => request.beforeSeq)).toEqual([8, 6])
    for (const [request] of page.mock.calls) expect(request).toMatchObject({ address: { kind: 'session', sessionId: 'owned' }, throughSeq: 9 })
  } finally { await ctx.fiber.dispose() }
})

it('rejects a journal backfill that does not advance', async () => {
  const ctx = new Context()
  ctx.provide('sessionController', {
    async *follow() { yield { type: 'snapshot', cursor: 9, records: [record(8), record(9)], hasMore: true } },
    page: async () => ({ records: [record(8)], hasMore: true }),
  } as never)
  ctx.provide('workspaceRegistry', {} as never)
  let api!: HostApiProxy
  await ctx.plugin({ apply(inner: Context) { api = createHostApi(inner, () => true) } })
  try {
    const stream = api.sessions.follow!({ rpcId: 'follow', payload: { sessionId: 'owned', afterSeq: -1 } }, new AbortController().signal)[Symbol.asyncIterator]()
    await expect(stream.next()).rejects.toThrow('Session journal page did not advance')
  } finally { await ctx.fiber.dispose() }
})

it.each(['caller', 'plugin'] as const)('closes the Host follower when the %s lifetime ends', async owner => {
  const ctx = new Context()
  let closed = false
  ctx.provide('sessionController', {
    async *follow(_request: unknown, signal: AbortSignal) {
      try {
        yield { type: 'snapshot', cursor: 0, records: [record(0)], hasMore: false }
        if (!signal.aborted) await new Promise<void>(resolve => { signal.addEventListener('abort', () => resolve(), { once: true }) })
      } finally { closed = true }
    },
  } as never)
  ctx.provide('workspaceRegistry', {} as never)
  let api!: HostApiProxy
  const fiber = await ctx.plugin({ apply(inner: Context) { api = createHostApi(inner, () => true) } })
  const abort = new AbortController()
  const stream = api.sessions.follow!({ rpcId: 'follow', payload: { sessionId: 'owned', afterSeq: -1 } }, abort.signal)[Symbol.asyncIterator]()
  try {
    expect((await stream.next()).value?.seq).toBe(0)
    const next = stream.next()
    if (owner === 'caller') abort.abort()
    else await fiber.dispose()
    expect((await next).done).toBe(true)
    expect(closed).toBe(true)
  } finally { abort.abort(); await stream.return?.(); await ctx.fiber.dispose() }
})
