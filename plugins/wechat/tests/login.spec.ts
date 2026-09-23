import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { remoteMethods } from '@deepseek-ai/dsh-typert-protocol'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { WeChatLoginService } from '../src/login.js'
import { WECHAT_LOGIN_REMOTE } from '../src/remote.js'
import { WeChatAccountStore } from '../src/storage.js'

afterEach(() => { vi.unstubAllGlobals() })

function logger() {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), success: vi.fn() } as never
}

async function loginFixture(statuses: object[], onAdded?: () => Promise<void>) {
  const requests: string[] = []
  vi.stubGlobal('fetch', vi.fn<typeof fetch>().mockImplementation(async input => {
    const url = String(input)
    requests.push(url)
    if (url.includes('get_bot_qrcode')) {
      return new Response(JSON.stringify({ qrcode: 'opaque-qr', qrcode_img_content: 'https://weixin.example/authorize' }), { status: 200 })
    }
    return new Response(JSON.stringify(statuses.shift() ?? { status: 'wait' }), { status: 200 })
  }))
  const directory = await mkdtemp(join(tmpdir(), 'dsh-wechat-login-'))
  const store = await WeChatAccountStore.open(directory)
  const ctx = new Context()
  const accountAdded = vi.fn(onAdded)
  const service = new WeChatLoginService(ctx, store, logger(), accountAdded)
  return { ctx, store, service, requests, accountAdded }
}

describe('WeChatLoginService', () => {
  it('preserves the scanning identity through the public Remote response codec', () => {
    const codec = WECHAT_LOGIN_REMOTE.descriptors[0]!.result
    expect(codec.mode).toBe('strict')
    if (codec.mode !== 'strict') throw new Error('Expected strict login view codec')
    expect(codec.create().parse({ status: 'idle', accounts: [{ accountId: 'account-a', userId: 'owner-a' }] }))
      .toEqual({ status: 'idle', accounts: [{ accountId: 'account-a', userId: 'owner-a' }] })
  })
  it('waits for automatic activation before reporting successful login', async () => {
    let finish!: () => void
    const activated = new Promise<void>(resolve => { finish = resolve })
    const fixture = await loginFixture([{ status: 'confirmed', ilink_bot_id: 'account-a', bot_token: 'test-token', ilink_user_id: 'owner-a' }], () => activated)
    await fixture.service.begin()
    await vi.waitFor(() => { expect(fixture.accountAdded).toHaveBeenCalledOnce() })
    expect(fixture.service.state().status).not.toBe('complete')
    expect(fixture.accountAdded).toHaveBeenCalledWith(expect.objectContaining({ userId: 'owner-a' }))
    finish()
    await vi.waitFor(() => { expect(fixture.service.state().status).toBe('complete') })
    await fixture.ctx.fiber.dispose()
  })

  it('keeps stored credentials but reports automatic activation failures honestly', async () => {
    const fixture = await loginFixture([{ status: 'confirmed', ilink_bot_id: 'account-a', bot_token: 'test-token', ilink_user_id: 'owner-a' }], async () => { throw new Error('settings read-only') })
    await fixture.service.begin()
    await vi.waitFor(() => { expect(fixture.service.state().status).toBe('failed') })
    expect(fixture.service.state()).toMatchObject({ accounts: [{ accountId: 'account-a', userId: 'owner-a' }], message: expect.stringContaining('接收服务启动失败') })
    expect(JSON.stringify(fixture.service.state())).not.toContain('test-token')
    await fixture.ctx.fiber.dispose()
  })
  it('publishes a QR flow and persists the confirmed account without exposing its token', async () => {
    const fixture = await loginFixture([
      { status: 'scaned' },
      { status: 'confirmed', ilink_bot_id: 'account-a', bot_token: 'secret-a',
        baseurl: 'https://ilink-a.example', ilink_user_id: 'owner-a' },
    ])

    const started = await fixture.service.begin()
    expect(remoteMethods(fixture.service).map(method => method.method)).toEqual(['state', 'begin', 'verify', 'cancel'])
    expect(WECHAT_LOGIN_REMOTE.descriptors.map(descriptor => descriptor.method)).toEqual(['state', 'begin', 'verify', 'cancel'])
    expect(started).toMatchObject({ status: 'qr', qrUrl: 'https://weixin.example/authorize' })
    expect(JSON.stringify(started)).not.toContain('secret-a')
    await vi.waitFor(() => { expect(fixture.service.state()).toMatchObject({ status: 'complete', accountId: 'account-a' }) })

    expect(fixture.store.accounts([])).toEqual([{
      accountId: 'account-a', token: 'secret-a', baseUrl: 'https://ilink-a.example', userId: 'owner-a',
    }])
    expect(fixture.accountAdded).toHaveBeenCalledOnce()
    await fixture.ctx.fiber.dispose()
  })

  it('accepts a numeric verification code through the active browser flow', async () => {
    const fixture = await loginFixture([
      { status: 'need_verifycode' },
      { status: 'confirmed', ilink_bot_id: 'account-b', bot_token: 'secret-b' },
    ])

    await fixture.service.begin()
    await vi.waitFor(() => { expect(fixture.service.state().status).toBe('verification-required') })
    expect(fixture.service.verify(' 1234 ').status).toBe('scanned')
    await vi.waitFor(() => { expect(fixture.service.state().status).toBe('complete') })

    expect(fixture.requests.some(url => url.includes('verify_code=1234'))).toBe(true)
    await fixture.ctx.fiber.dispose()
  })

  it('keeps upstream QR failures and response bodies out of browser state', async () => {
    vi.stubGlobal('fetch', vi.fn<typeof fetch>().mockResolvedValue(new Response(
      '{"bot_token":"secret-from-upstream"}',
      { status: 500 },
    )))
    const directory = await mkdtemp(join(tmpdir(), 'dsh-wechat-login-error-'))
    const store = await WeChatAccountStore.open(directory)
    const ctx = new Context()
    const service = new WeChatLoginService(ctx, store, logger(), vi.fn())

    const view = await service.begin()

    expect(view).toMatchObject({ status: 'failed', message: '无法生成微信登录二维码，请稍后重试。' })
    expect(JSON.stringify(view)).not.toContain('secret-from-upstream')
    await ctx.fiber.dispose()
  })
})
