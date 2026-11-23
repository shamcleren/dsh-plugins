import { afterEach, expect, it, vi } from 'vitest'
import { createWorkspaceStore } from '../src/client/workspace-store.ts'
afterEach(() => vi.useRealTimers())
const state = (revision = 1, sessionId = 'one') => ({ revision, sessionId, generation: 'generation', title: 'Result' })
it('shares one serial poll across subscribers and does not publish unchanged revisions', async () => {
  vi.useFakeTimers()
  const remote = { state: vi.fn(async () => state()) }, store = createWorkspaceStore(remote, 'one'), a = vi.fn(), b = vi.fn()
  const stopA = store.subscribe(a), stopB = store.subscribe(b)
  await vi.advanceTimersByTimeAsync(0)
  expect(remote.state).toHaveBeenCalledTimes(1); expect(a).toHaveBeenCalledTimes(1); expect(b).toHaveBeenCalledTimes(1)
  await vi.advanceTimersByTimeAsync(750)
  expect(remote.state).toHaveBeenCalledTimes(2); expect(a).toHaveBeenCalledTimes(1)
  stopA(); await vi.advanceTimersByTimeAsync(750); expect(remote.state).toHaveBeenCalledTimes(3)
  stopB(); expect(remote.state.mock.calls.at(-1)[1].aborted).toBe(true)
  await vi.advanceTimersByTimeAsync(1500); expect(remote.state).toHaveBeenCalledTimes(3)
})
it('shows disconnection, preserves evidence, and recovers on an explicit reconnect', async () => {
  vi.useFakeTimers()
  const remote = { state: vi.fn().mockResolvedValueOnce(state()).mockRejectedValueOnce(new Error('offline')).mockResolvedValue(state(2)) }
  const store = createWorkspaceStore(remote, 'one'), stop = store.subscribe(() => {})
  await vi.advanceTimersByTimeAsync(750)
  expect(store.getSnapshot()).toEqual({ state: state(), connection: 'disconnected' })
  store.retry(); await vi.advanceTimersByTimeAsync(0)
  expect(store.getSnapshot()).toEqual({ state: state(2), connection: 'connected' })
  stop()
})
it('ignores a late response after unsubscribe or retry, without scheduling orphan polls', async () => {
  vi.useFakeTimers(); let resolve
  const remote = { state: vi.fn().mockImplementationOnce(() => new Promise(done => { resolve = done })).mockResolvedValue(state(2)) }
  const store = createWorkspaceStore(remote, 'one'), stop = store.subscribe(() => {})
  store.retry(); await vi.advanceTimersByTimeAsync(0)
  resolve(state(99)); await vi.advanceTimersByTimeAsync(0)
  expect(store.getSnapshot().state.revision).toBe(2)
  stop(); await vi.advanceTimersByTimeAsync(1500); expect(remote.state).toHaveBeenCalledTimes(2)
})
