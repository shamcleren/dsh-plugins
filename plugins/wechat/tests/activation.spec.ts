import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { SettingsProvider, type SettingsNamespace } from '@deepseek-ai/dsh-settings'
import { afterEach, expect, it, vi } from 'vitest'
import * as WeChat from '../src/index.js'
import { WeChatAccountStore } from '../src/storage.js'
import type { WeChatLoginService } from '../src/login.js'

const observed = vi.hoisted(() => ({ started: vi.fn(), stopped: vi.fn(), router: vi.fn() }))
vi.mock('../src/account.js', () => ({ WeChatAccount: class {
  start(): void { observed.started() }
  async stop(): Promise<void> { observed.stopped() }
} }))
vi.mock('../src/router.js', () => ({ WeChatConversationRouter: class {
  constructor(_api: unknown, _replies: unknown, _logger: unknown, config: unknown) { observed.router(config) }
  start(): void {}
  setAgentPreset(): void {}
  async stop(): Promise<void> {}
} }))

afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.clearAllMocks() })

it.each(['scanning-owner', undefined])('QR auto-activation requires the scanning identity (%s)', async owner => {
  const directory = await mkdtemp(join(tmpdir(), 'wechat-activation-'))
  vi.stubEnv('DSH_HOME', directory)
  const document: Record<string, Record<string, unknown>> = {
    wechat: { enabled: false, accountIds: ['previous-account'], workspaceId: 'workspace-a' },
  }
  class MemorySettings extends SettingsProvider {
    readonly writable = true
    protected async load(): Promise<Record<string, unknown>> { return document }
    protected async persist(ns: SettingsNamespace, section: Record<string, unknown>): Promise<void> { document[ns] = section }
  }
  vi.stubGlobal('fetch', vi.fn<typeof fetch>().mockImplementation(async input => new Response(JSON.stringify(
    String(input).includes('get_bot_qrcode')
      ? { qrcode: 'test-qr', qrcode_img_content: 'https://weixin.example/authorize' }
      : { status: 'confirmed', ilink_bot_id: 'new-account', ilink_user_id: owner, bot_token: 'fixture-token' },
  ))))
  const ctx = new Context()
  ctx.provide('sessionController', {} as never)
  ctx.provide('sessions', {} as never)
  ctx.provide('workspaceRegistry', { list: () => [{ id: 'workspace-a', path: directory, title: 'Test', sessionIds: [] }], archivedSessionIds: [] } as never)
  try {
    const settings = await ctx.plugin(MemorySettings)
    const fiber = await settings.ctx.plugin(WeChat, {})
    await vi.waitFor(() => { expect(fiber.ctx.get('wechatLogin' as never)).toBeDefined() })
    const login = fiber.ctx.get('wechatLogin' as never) as unknown as WeChatLoginService
    expect(observed.started).not.toHaveBeenCalled()
    await login.begin()
    await vi.waitFor(() => { expect(login.state().status).toBe(owner ? 'complete' : 'failed') })
    expect(document.wechat).toEqual({ enabled: false, accountIds: ['previous-account'], workspaceId: 'workspace-a' })
    expect(observed.started).toHaveBeenCalledTimes(owner ? 1 : 0)
    if (owner) expect(observed.router).toHaveBeenCalledWith(expect.objectContaining({ adminUsers: [owner] }))
    else expect(observed.router).not.toHaveBeenCalled()
    await fiber.dispose()
    expect(observed.stopped).toHaveBeenCalledTimes(owner ? 1 : 0)
  } finally { await ctx.fiber.dispose(); await rm(directory, { recursive: true, force: true }) }
})


it('starts every previously bound account on load even with retired disabled/filter settings and read-only settings', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'wechat-existing-'))
  vi.stubEnv('DSH_HOME', directory)
  const store = await WeChatAccountStore.open(join(directory, 'channels/wechat'))
  for (const accountId of ['account-a', 'account-b']) await store.saveAccount({ accountId, userId: 'owner-' + accountId, token: 'fixture-only', baseUrl: 'https://example.invalid' })
  class ReadOnlySettings extends SettingsProvider {
    readonly writable = false
    protected async load() { return { wechat: { enabled: false, accountIds: ['missing-account'], allowedUsers: ['old-user'], adminUsers: ['old-admin'], workspaceId: 'workspace-a' } } }
    protected async persist() { throw new Error('Must not write settings') }
  }
  const ctx = new Context()
  ctx.provide('sessionController', {} as never)
  ctx.provide('sessions', {} as never)
  ctx.provide('workspaceRegistry', { list: () => [{ id: 'workspace-a', path: directory, title: 'Test', sessionIds: [] }], archivedSessionIds: [] } as never)
  try {
    const settings = await ctx.plugin(ReadOnlySettings), fiber = await settings.ctx.plugin(WeChat, {})
    await vi.waitFor(() => expect(observed.started).toHaveBeenCalledTimes(2))
    const login = fiber.ctx.get('wechatLogin' as never) as unknown as WeChatLoginService
    expect(login.state()).toMatchObject({ receiver: { status: 'running', accounts: 2 } })
    expect(observed.router).toHaveBeenCalledWith(expect.objectContaining({ adminUsers: ['owner-account-a'] }))
    await fiber.dispose()
    expect(observed.stopped).toHaveBeenCalledTimes(2)
  } finally { await ctx.fiber.dispose(); await rm(directory, { recursive: true, force: true }) }
})
