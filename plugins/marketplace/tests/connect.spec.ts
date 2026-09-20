import { afterEach, expect, it, vi } from 'vitest'
import { connectSource } from '../src/client/connect.ts'
import type { MarketplaceRemote } from '../src/client/types.ts'

afterEach(() => { vi.useRealTimers() })

function fixture() {
  const remote = { beginOAuth: vi.fn(async () => ({ flowId: 'flow', authorizationUrl: 'https://gitlab.example.com/oauth/authorize' })),
    oauthStatus: vi.fn(async () => ({ status: 'complete' })), configure: vi.fn(), refreshCatalog: vi.fn() }
  const controller = new AbortController()
  return { remote, api: remote as unknown as MarketplaceRemote, controller,
    options: { authorize: true, signal: controller.signal, open: vi.fn(), timeoutMessage: 'timed out' } }
}

it('connects the exact entered repository and refreshes the catalog after OAuth completes', async () => {
  vi.useFakeTimers()
  const f = fixture()
  const promise = connectSource(f.api, 'https://gitlab.example.com/team/my-plugins', f.options)
  await vi.advanceTimersByTimeAsync(750)
  await promise
  expect(f.remote.beginOAuth).toHaveBeenCalledWith({ repositoryUrl: 'https://gitlab.example.com/team/my-plugins' })
  expect(f.options.open).toHaveBeenCalledOnce()
  expect(f.remote.configure).toHaveBeenCalledWith({ repositoryUrl: 'https://gitlab.example.com/team/my-plugins' })
  expect(f.remote.refreshCatalog).toHaveBeenCalledOnce()
})

it('reuses OAuth authorization when saving another repository', async () => {
  const f = fixture()
  await connectSource(f.api, 'https://gitlab.example.com/team/my-plugins', { ...f.options, authorize: false })
  expect(f.remote.beginOAuth).not.toHaveBeenCalled()
  expect(f.remote.configure).toHaveBeenCalledOnce()
})

it('stops polling when the panel unmounts and never saves a pending source', async () => {
  vi.useFakeTimers()
  const f = fixture()
  const promise = connectSource(f.api, 'https://gitlab.example.com/team/my-plugins', f.options)
  const rejected = expect(promise).rejects.toThrow()
  await vi.advanceTimersByTimeAsync(1)
  f.controller.abort()
  await rejected
  await vi.advanceTimersByTimeAsync(5000)
  expect(f.remote.oauthStatus).not.toHaveBeenCalled()
  expect(f.remote.configure).not.toHaveBeenCalled()
  expect(vi.getTimerCount()).toBe(0)
})

it('does not save or fetch a catalog after authorization is denied', async () => {
  vi.useFakeTimers()
  const f = fixture()
  f.remote.oauthStatus.mockResolvedValue({ status: 'failed', message: 'denied' } as never)
  const rejected = expect(connectSource(f.api, 'https://gitlab.example.com/team/my-plugins', f.options)).rejects.toThrow('denied')
  await vi.advanceTimersByTimeAsync(750)
  await rejected
  expect(f.remote.configure).not.toHaveBeenCalled()
  expect(f.remote.refreshCatalog).not.toHaveBeenCalled()
})
