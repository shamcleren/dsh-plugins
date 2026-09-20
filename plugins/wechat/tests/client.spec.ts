import { describe, expect, it, vi } from 'vitest'
import type { SettingsScope, SettingsScopeSnapshot } from '@deepseek-ai/dsh-client-ui-settings/client'
import type { Config } from '../src/config.js'
import { ChannelBadge } from '../src/client/index.js'
import { WeChatCardController } from '../src/client/controller.js'
import { zh } from '../src/client/locales.js'

function success<T>(value: T) {
  return Promise.resolve({ ok: true as const, value })
}

function settingsScope(): {
  scope: SettingsScope<Config>
  set: ReturnType<typeof vi.fn>
  unset: ReturnType<typeof vi.fn>
  publish(patch: Partial<SettingsScopeSnapshot<Config>>): void
} {
  let snapshot: SettingsScopeSnapshot<Config> = {
    status: 'ready', value: {}, base: {}, user: {},
    revision: 1, writable: true, mode: 'host',
  }
  const listeners = new Set<() => void>()
  const set = vi.fn(async () => {})
  const unset = vi.fn(async () => {})
  return {
    set,
    unset,
    publish(patch) {
      snapshot = { ...snapshot, ...patch }
      for (const listener of listeners) listener()
    },
    scope: {
      mutate: vi.fn(async () => {}),
      getSnapshot: () => snapshot,
      subscribe(listener) {
        listeners.add(listener)
        return () => listeners.delete(listener)
      },
      set,
      unset,
    },
  }
}

function presetsApi() {
  return {
    list: vi.fn(() => Promise.resolve({ result: {
      ok: true as const,
      value: {
        items: [
          { id: 'standard', name: '标准' },
          { id: 'half-authored', broken: '缺少 agent.cordis.yml' },
        ],
        defaultId: 'standard',
      },
    } })),
  }
}

describe('WeChat settings login controller', () => {
  it('turns a Host QR URL into a scannable image inside the settings card', async () => {
    const remote = {
      state: vi.fn(() => success({ status: 'idle' as const, accounts: [] })),
      begin: vi.fn(() => success({
        status: 'qr' as const, accounts: [], flowId: 'flow-a',
        qrUrl: 'https://weixin.example/authorize', expiresAt: Date.now() + 60_000,
      })),
      verify: vi.fn(), cancel: vi.fn(),
    }
    const controller = new WeChatCardController(remote as never, settingsScope().scope, presetsApi())
    const face = controller.inject()
    await vi.waitFor(() => { expect(remote.state).toHaveBeenCalledOnce() })

    face.beginLogin()

    await vi.waitFor(() => {
      expect(face.hooks.weChatCard.getSnapshot()).toMatchObject({
        login: { status: 'qr', flowId: 'flow-a' },
        qrDataUrl: expect.stringMatching(/^data:image\/svg\+xml/u),
      })
    })
    controller.dispose()
  })

  it('submits the card verification code and renders the connected account', async () => {
    const remote = {
      state: vi.fn(() => success({ status: 'idle' as const, accounts: [] })),
      begin: vi.fn(() => success({
        status: 'verification-required' as const, accounts: [], flowId: 'flow-b',
        qrUrl: 'https://weixin.example/verify', expiresAt: Date.now() + 60_000,
      })),
      verify: vi.fn(() => success({
        status: 'complete' as const, accountId: 'account-b', accounts: [{ accountId: 'account-b' }],
      })),
      cancel: vi.fn(),
    }
    const controller = new WeChatCardController(remote as never, settingsScope().scope, presetsApi())
    const face = controller.inject()
    await vi.waitFor(() => { expect(remote.state).toHaveBeenCalledOnce() })
    face.beginLogin()
    await vi.waitFor(() => { expect(face.hooks.weChatCard.getSnapshot().login.status).toBe('verification-required') })

    face.setVerificationCode('12x34')
    face.submitVerification()

    await vi.waitFor(() => { expect(remote.verify).toHaveBeenCalledWith('1234') })
    expect(face.hooks.weChatCard.getSnapshot().login).toMatchObject({ status: 'complete', accountId: 'account-b' })
    controller.dispose()
  })

  it('loads the preset roster and reports a refused channel preset write', async () => {
    const remote = {
      state: vi.fn(() => success({ status: 'idle' as const, accounts: [] })),
      begin: vi.fn(), verify: vi.fn(), cancel: vi.fn(),
    }
    const settings = settingsScope()
    const presets = presetsApi()
    const controller = new WeChatCardController(remote as never, settings.scope, presets)
    await vi.waitFor(() => {
      expect(controller.inject().hooks.weChatCard.getSnapshot().presetOptions).toEqual([
        { id: 'standard', name: '标准' },
        { id: 'half-authored', broken: '缺少 agent.cordis.yml' },
      ])
    })
    const face = controller.inject()
    face.editPreset('standard')
    settings.set.mockRejectedValueOnce(new Error('settings provider is read-only'))
    face.savePreset()

    await vi.waitFor(() => {
      expect(face.hooks.weChatCard.getSnapshot()).toMatchObject({
        failed: true,
        failureMessage: 'settings provider is read-only',
        presetText: 'standard',
      })
    })
    controller.dispose()
  })

  it('does not offer a hand-entered preset when the roster cannot be read', async () => {
    const remote = {
      state: vi.fn(() => success({ status: 'idle' as const, accounts: [] })),
      begin: vi.fn(), verify: vi.fn(), cancel: vi.fn(),
    }
    const presets = presetsApi()
    presets.list.mockImplementationOnce(() => Promise.resolve({
      result: { ok: false as const, error: { code: 'presets-unavailable', message: 'no registry' } },
    }) as never)
    const controller = new WeChatCardController(remote as never, settingsScope().scope, presets)

    await vi.waitFor(() => {
      expect(controller.inject().hooks.weChatCard.getSnapshot().presetsFailed).toBe(true)
    })
    expect(controller.inject().hooks.weChatCard.getSnapshot().presetOptions).toEqual([])
    controller.dispose()
  })
})

describe('WeChat session badge', () => {
  it('marks a WeChat session header and stays hidden for other sessions', () => {
    const t = (key: keyof typeof zh) => zh[key]
    expect(ChannelBadge({ sessionId: 'session-wechat-abc', t })).toEqual(expect.objectContaining({
      props: expect.objectContaining({ className: 'wechat-session-badge', title: '微信' }),
    }))
    expect(ChannelBadge({ sessionId: 'session-wecom-abc', t })).toBeNull()
  })
})
