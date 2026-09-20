import { describe, expect, it, vi } from 'vitest'
import type { SettingsScope, SettingsScopeSnapshot } from '@deepseek-ai/dsh-client-ui-settings/client'
import type { Config } from '../src/config.js'
import { ChannelBadge } from '../src/client/index.js'
import { WeComCardController } from '../src/client/controller.js'
import { zh } from '../src/client/locales.js'

interface StubSettingsScope<T> {
  scope: SettingsScope<T>
  set: ReturnType<typeof vi.fn>
  unset: ReturnType<typeof vi.fn>
  publish(patch: Partial<SettingsScopeSnapshot<T>>): void
}

function stubSettingsScope<T>(): StubSettingsScope<T> {
  let snapshot: SettingsScopeSnapshot<T> = {
    status: 'loading', value: undefined, base: undefined, user: undefined,
    revision: undefined, writable: false, mode: 'host',
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

function acceptWrites(host: StubSettingsScope<Config>): void {
  const value = (): Record<string, unknown> => ({ ...host.scope.getSnapshot().value as object })
  const user = (): Record<string, unknown> => ({ ...host.scope.getSnapshot().user as object })
  host.set.mockImplementation((field: string, next: unknown) => {
    host.publish({ value: { ...value(), [field]: next }, user: { ...user(), [field]: next } })
  })
  host.unset.mockImplementation((field: string) => {
    const nextUser = Object.fromEntries(Object.entries(user()).filter(([key]) => key !== field))
    const base = host.scope.getSnapshot().base as Record<string, unknown> | undefined
    host.publish({ value: { ...value(), [field]: base?.[field] }, user: nextUser })
  })
}

function credentialsApi(configured: boolean) {
  const describe = vi.fn(() => Promise.resolve({
    rpcId: 'credential-read' as never,
    result: { ok: true as const, value: { credentials: {
      WECOM_BOT_ID: { configured, writable: true },
      WECOM_BOT_SECRET: { configured, writable: true },
    } } },
  }))
  const set = vi.fn(() => Promise.resolve({
    rpcId: 'credential-write' as never,
    result: { ok: true as const, value: {} },
  }))
  const list = vi.fn(() => Promise.resolve({
    rpcId: 'workspace-list' as never,
    result: { ok: true as const, value: {
      items: [{
        workspaceId: 'workspace-project' as never,
        title: '项目 Alpha',
        path: '/workspaces/project-alpha',
        sessionIds: [],
        createdAt: '2026-08-24T00:00:00.000Z',
        updatedAt: '2026-08-24T00:00:00.000Z',
      }],
      archivedSessionIds: [],
    } },
  }))
  const presets = vi.fn(() => Promise.resolve({
    rpcId: 'preset-list' as never,
    result: { ok: true as const, value: {
      items: [
        { id: 'standard', name: '标准' },
        { id: 'half-authored', broken: '缺少 agent.cordis.yml' },
      ],
      defaultId: 'standard',
    } },
  }))
  return {
    api: { credentials: { describe, set }, workspace: { list }, presets: { list: presets } } as never,
    describe,
    set,
    list,
    presets,
  }
}

describe('WeCom browser settings card', () => {
  it('is available before the Bot credentials are configured', async () => {
    const host = stubSettingsScope<Config>()
    const credentials = credentialsApi(false)
    const controller = new WeComCardController(host.scope, credentials.api)
    host.publish({
      status: 'ready',
      writable: true,
      value: { allowedUsers: [], thinkingText: '正在思考…', turnTimeoutMs: 300_000 },
      base: { allowedUsers: [], thinkingText: '正在思考…', turnTimeoutMs: 300_000 },
      user: {},
    })
    await vi.waitFor(() => { expect(credentials.describe).toHaveBeenCalled() })

    await vi.waitFor(() => { expect(credentials.presets).toHaveBeenCalled() })
    expect(controller.inject().hooks.weComCard.getSnapshot()).toMatchObject({
      available: true,
      botIdConfigured: false,
      secretConfigured: false,
      workspaceOptions: [{ id: 'workspace-project', title: '项目 Alpha' }],
      presetOptions: [
        { id: 'standard', name: '标准' },
        { id: 'half-authored', broken: '缺少 agent.cordis.yml' },
      ],
      presetDefaultId: 'standard',
      presetsFailed: false,
    })
  })

  it('keeps the preset picker closed when the roster cannot be read', async () => {
    const host = stubSettingsScope<Config>()
    const credentials = credentialsApi(false)
    credentials.presets.mockImplementationOnce(() => Promise.resolve({
      rpcId: 'preset-list' as never,
      result: { ok: false as const, error: { code: 'presets-unavailable', message: 'no registry' } },
    }) as never)
    const controller = new WeComCardController(host.scope, credentials.api)
    host.publish({ status: 'ready', writable: true, value: {}, base: {}, user: {} })

    await vi.waitFor(() => {
      expect(controller.inject().hooks.weComCard.getSnapshot().presetsFailed).toBe(true)
    })
    expect(controller.inject().hooks.weComCard.getSnapshot().presetOptions).toEqual([])
  })

  it('rejects edits to fields the card no longer exposes', () => {
    const host = stubSettingsScope<Config>()
    const controller = new WeComCardController(host.scope, credentialsApi(false).api)
    host.publish({ status: 'ready', writable: true, value: {}, base: {}, user: {} })

    expect(() => { controller.inject().edit('enabled', 'true') }).toThrow(/no field enabled/u)
    expect(host.set).not.toHaveBeenCalled()
  })

  it('writes settings and credentials through their separate stores', async () => {
    const host = stubSettingsScope<Config>()
    acceptWrites(host)
    const credentials = credentialsApi(false)
    const controller = new WeComCardController(host.scope, credentials.api)
    host.publish({ status: 'ready', writable: true, value: { preventIdleSleep: false }, base: { preventIdleSleep: false }, user: {} })
    const face = controller.inject()

    face.edit('allowedUsers', 'zhangsan, lisi')
    face.edit('workspaceId', 'workspace-project')
    face.edit('preventIdleSleep', 'true')
    face.edit('botId', ' bot-id ')
    face.edit('secret', ' bot-secret ')
    credentials.describe.mockImplementation(() => Promise.resolve({
      rpcId: 'credential-read' as never,
      result: { ok: true as const, value: { credentials: {
        WECOM_BOT_ID: { configured: true, writable: true },
        WECOM_BOT_SECRET: { configured: true, writable: true },
      } } },
    }))
    face.save()

    await vi.waitFor(() => { expect(credentials.set).toHaveBeenCalledTimes(2) })
    expect(host.set.mock.calls).toEqual([
      ['allowedUsers', ['zhangsan', 'lisi']],
      ['workspaceId', 'workspace-project'],
      ['preventIdleSleep', true],
    ])
    expect(credentials.set.mock.calls).toEqual([
      [{ ref: 'WECOM_BOT_ID', value: 'bot-id' }],
      [{ ref: 'WECOM_BOT_SECRET', value: 'bot-secret' }],
    ])
  })

  it('surfaces the deployment refusal that kept a credential unconfigured', async () => {
    const host = stubSettingsScope<Config>()
    const credentials = credentialsApi(false)
    credentials.set.mockImplementation(() => Promise.resolve({
      rpcId: 'credential-write' as never,
      result: { ok: false as const, error: Object.assign(new Error('credentials service is absent'), { code: 'gateway/internal' }) },
    }) as never)
    const controller = new WeComCardController(host.scope, credentials.api)
    host.publish({ status: 'ready', writable: true, value: {}, base: {}, user: {} })
    const face = controller.inject()

    face.edit('botId', 'bot-id')
    face.save()

    await vi.waitFor(() => {
      expect(controller.inject().hooks.weComCard.getSnapshot()).toMatchObject({
        failed: true,
        rejected: ['botId'],
        credentialFailure: { ref: 'WECOM_BOT_ID', message: 'credentials service is absent' },
      })
    })
  })

  it('reports a credential the deployment accepted but still calls unconfigured', async () => {
    const host = stubSettingsScope<Config>()
    const credentials = credentialsApi(false)
    const controller = new WeComCardController(host.scope, credentials.api)
    host.publish({ status: 'ready', writable: true, value: {}, base: {}, user: {} })
    const face = controller.inject()

    face.edit('secret', 'bot-secret')
    face.save()

    await vi.waitFor(() => {
      const snapshot = controller.inject().hooks.weComCard.getSnapshot()
      expect(snapshot.credentialFailure).toEqual({ ref: 'WECOM_BOT_SECRET' })
      expect(snapshot.rejected).toEqual(['secret'])
    })
  })

  it('names the settings fields a deployment did not accept', async () => {
    const host = stubSettingsScope<Config>()
    const credentials = credentialsApi(true)
    const controller = new WeComCardController(host.scope, credentials.api)
    host.publish({ status: 'ready', writable: true, value: {}, base: {}, user: {} })
    const face = controller.inject()

    face.edit('adminUsers', 'shamcleren')
    face.edit('workspaceId', 'workspace-project')
    face.save()

    await vi.waitFor(() => {
      expect(controller.inject().hooks.weComCard.getSnapshot()).toMatchObject({
        failed: true,
        rejected: ['adminUsers', 'workspaceId'],
      })
    })
    expect(host.set).toHaveBeenCalledTimes(2)
  })

  it('clears a reported failure when the edits are discarded', async () => {
    const host = stubSettingsScope<Config>()
    const credentials = credentialsApi(true)
    const controller = new WeComCardController(host.scope, credentials.api)
    host.publish({ status: 'ready', writable: true, value: {}, base: {}, user: {} })
    const face = controller.inject()

    face.edit('adminUsers', 'shamcleren')
    face.save()
    await vi.waitFor(() => { expect(controller.inject().hooks.weComCard.getSnapshot().failed).toBe(true) })

    face.discard()
    expect(controller.inject().hooks.weComCard.getSnapshot()).toMatchObject({ failed: false, rejected: [] })
  })

  it('refreshes only credential references owned by the card', async () => {
    const host = stubSettingsScope<Config>()
    const credentials = credentialsApi(false)
    const controller = new WeComCardController(host.scope, credentials.api)
    host.publish({ status: 'ready', writable: true, value: {}, user: {} })
    await vi.waitFor(() => { expect(credentials.describe).toHaveBeenCalled() })
    credentials.describe.mockClear()

    controller.refreshCredential('OTHER_KEY')
    expect(credentials.describe).not.toHaveBeenCalled()
    controller.refreshCredential('WECOM_BOT_SECRET')
    await vi.waitFor(() => { expect(credentials.describe).toHaveBeenCalledTimes(1) })
  })
})

describe('WeCom session badge', () => {
  it('marks a WeCom session header and stays hidden for other sessions', () => {
    const t = (key: keyof typeof zh) => zh[key]
    expect(ChannelBadge({ sessionId: 'session-wecom-abc', t })).toEqual(expect.objectContaining({
      props: expect.objectContaining({ className: 'wecom-session-badge', title: '企业微信' }),
    }))
    expect(ChannelBadge({ sessionId: 'session-wechat-abc', t })).toBeNull()
  })
})
