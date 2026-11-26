import { afterEach, expect, it, vi } from 'vitest'
import { WeChatTyping } from '../../src/adapters/wechat/typing.js'

afterEach(() => { vi.useRealTimers() })

it('shares one refresh loop and cancels only after the last turn releases the peer', async () => {
  vi.useFakeTimers()
  const send = vi.fn(async (_user: string, _status: 1 | 2, _token: string | undefined, _signal: AbortSignal) => undefined)
  const typing = new WeChatTyping(send, vi.fn())
  const first = typing.acquire('peer', 'user', 'old-context')
  const second = typing.acquire('peer', 'user', 'new-context')
  try {
    await vi.advanceTimersByTimeAsync(5_000)
    expect(send.mock.calls.map(call => call[1])).toEqual([1, 1])
    expect(send.mock.calls[1]?.[2]).toBe('new-context')
    await first()
    expect(send).toHaveBeenCalledTimes(2)
    await second()
    expect(send.mock.calls.map(call => call[1])).toEqual([1, 1, 2])
    await vi.advanceTimersByTimeAsync(30_000)
    expect(send).toHaveBeenCalledTimes(3)
    expect(vi.getTimerCount()).toBe(0)
  } finally { await typing.stop() }
})

it('aborts and joins an in-flight refresh before sending the terminal cancel', async () => {
  vi.useFakeTimers()
  const order: string[] = []
  const typing = new WeChatTyping(async (_user, status, _token, signal) => {
    order.push(`start:${status}`)
    if (status === 1) await new Promise<void>(resolve => { signal.addEventListener('abort', () => resolve(), { once: true }) })
    order.push(`end:${status}`)
  }, vi.fn())
  const release = typing.acquire('peer', 'user', undefined)
  await vi.advanceTimersByTimeAsync(20_000)
  expect(order).toEqual(['start:1'])
  await release()
  expect(order).toEqual(['start:1', 'end:1', 'start:2', 'end:2'])
  await typing.stop()
})

it('waits for an older cancel before a new turn starts the same peer typing', async () => {
  vi.useFakeTimers()
  let cancel!: () => void
  const cancelled = new Promise<void>(resolve => { cancel = resolve })
  const statuses: number[] = []
  const typing = new WeChatTyping(async (_user, status) => {
    statuses.push(status)
    if (status === 2) await cancelled
  }, vi.fn())
  const first = typing.acquire('peer', 'user', undefined)
  const finished = first()
  await vi.advanceTimersByTimeAsync(0)
  const second = typing.acquire('peer', 'user', undefined)
  await vi.advanceTimersByTimeAsync(0)
  expect(statuses).toEqual([1, 2])
  cancel()
  await finished
  await vi.advanceTimersByTimeAsync(0)
  expect(statuses).toEqual([1, 2, 1])
  await second()
  await typing.stop()
  expect(statuses).toEqual([1, 2, 1, 2])
  expect(vi.getTimerCount()).toBe(0)
})

it('stops every peer on disposal and refuses further refresh ownership', async () => {
  vi.useFakeTimers()
  const send = vi.fn(async (_user: string, _status: 1 | 2) => undefined)
  const typing = new WeChatTyping(send, vi.fn())
  typing.acquire('first', 'user-a', undefined)
  typing.acquire('second', 'user-b', undefined)
  await vi.advanceTimersByTimeAsync(5_000)
  await typing.stop()
  const count = send.mock.calls.length
  await typing.acquire('third', 'user-c', undefined)()
  await vi.advanceTimersByTimeAsync(30_000)
  expect(send).toHaveBeenCalledTimes(count)
  expect(send.mock.calls.filter(call => call[1] === 2).map(call => call[0]).sort()).toEqual(['user-a', 'user-b'])
  expect(vi.getTimerCount()).toBe(0)
})
