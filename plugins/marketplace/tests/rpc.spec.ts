import { describe, expect, it, vi } from 'vitest'
import { createMarketplaceRpcHandler } from '../src/rpc.ts'

describe('Marketplace RPC', () => {
  it('accepts one repository address and rejects token, application, and repository-list requests', async () => {
    const configure = vi.fn(), beginOAuth = vi.fn()
    const handler = createMarketplaceRpcHandler({ configure, beginOAuth } as never, vi.fn())
    const signal = new AbortController().signal
    const request = { repositoryUrl: 'https://gitlab.example.com/team/plugins' }
    expect(await handler('configure', request, signal)).toMatchObject({ ok: true })
    expect(await handler('beginOAuth', request, signal)).toMatchObject({ ok: true })
    for (const extra of [{ token: 'private-token' }, { clientId: 'custom-app' }, { ref: 'main' }]) {
      expect(await handler('configure', { ...request, ...extra }, signal)).toMatchObject({ ok: false, error: { code: 'bad-request' } })
    }
    expect(await handler('repositories', {}, signal)).toMatchObject({ ok: false, error: { code: 'bad-request' } })
    expect(configure).toHaveBeenCalledTimes(1)
  })
  it('rejects unknown methods and malformed installation requests before mutation', async () => {
    const add = vi.fn()
    const handler = createMarketplaceRpcHandler({ add } as never, vi.fn())
    const signal = new AbortController().signal
    expect(await handler('constructor', {}, signal)).toMatchObject({ ok: false, error: { code: 'bad-request', details: { issues: [] } } })
    expect(await handler('add', { packageName: 'ok', command: 'extra' }, signal)).toMatchObject({
      ok: false, error: { code: 'bad-request', details: { issues: [expect.objectContaining({ code: 'unrecognized_keys' })] } },
    })
    expect(add).not.toHaveBeenCalled()
  })
  it('calls the package installer using the catalog package identity', async () => {
    const add = vi.fn(async () => ({ packageName: 'demo', restartRequired: true }))
    const handler = createMarketplaceRpcHandler({ add } as never, vi.fn())
    expect(await handler('add', { packageName: 'demo' }, new AbortController().signal))
      .toMatchObject({ ok: true, value: { restartRequired: true } })
    expect(add).toHaveBeenCalledExactlyOnceWith('demo')
  })
})
