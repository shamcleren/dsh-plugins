import * as Cordis from '@deepseek-ai/cordis'
import type { ConnectionHandle } from '@deepseek-ai/dsh-client-connection/client'
import TypertRegistry from '@deepseek-ai/dsh-typert-registry'
import { describe, expect, it, vi } from 'vitest'
import { apply as applyWechatClient, inject as injectWechatClient } from '../src/client/index.js'
import { WECHAT_LOGIN_REMOTE } from '../src/remote.js'

describe('WeChat login Remote contribution', () => {
  it('mounts without the settings plugin load failure', async () => {
    const gateway = await loadBrowserGateway()
    const ctx = new Cordis.Context()
    await ctx.plugin(TypertRegistry)
    ctx.provide('connection', {
      start: vi.fn(),
      registerGenerationSource: vi.fn(() => () => {}),
      rpc: { call: vi.fn<ConnectionHandle['rpc']['call']>() },
    } as unknown as ConnectionHandle)
    await ctx.plugin(gateway)

    await expect(ctx.remote.$mount(WECHAT_LOGIN_REMOTE)).resolves.toBeTypeOf('function')
  })

  it('activates the complete client loader entry after mounting its Remote namespace', async () => {
    const gateway = await loadBrowserGateway()
    const ctx = new Cordis.Context()
    await ctx.plugin(TypertRegistry)
    ctx.provide('connection', {
      start: vi.fn(),
      registerGenerationSource: vi.fn(() => () => {}),
      rpc: { call: vi.fn<ConnectionHandle['rpc']['call']>().mockResolvedValue({
        ok: true,
        value: { status: 'idle', accounts: [] },
      }) },
    } as unknown as ConnectionHandle)
    ctx.provide('slots', { inject: vi.fn(), register: vi.fn() } as never)
    ctx.provide('locale', { register: vi.fn(() => () => {}) } as never)
    await ctx.plugin(gateway)

    await expect(ctx.plugin({ apply: applyWechatClient, inject: injectWechatClient }))
      .resolves.toBeDefined()
  })
})

let browserGateway: Cordis.Plugin.Object | undefined

async function loadBrowserGateway(): Promise<Cordis.Plugin.Object> {
  if (browserGateway !== undefined) return browserGateway
  let gateway: Cordis.Plugin.Object | undefined
  const browser = {
    __ModuleLoader__: {
      load(module: {
        id: string
        factory: (require: (id: string) => typeof Cordis) => Cordis.Plugin.Object
      }) {
        gateway = module.factory((id) => {
          if (id !== '@deepseek-ai/cordis') throw new Error(`unexpected browser dependency: ${id}`)
          return Cordis
        })
      },
    },
  }
  Object.defineProperty(globalThis, 'window', { configurable: true, value: browser })
  try {
    await import('@deepseek-ai/dsh-api-gateway/client')
  } finally {
    Reflect.deleteProperty(globalThis, 'window')
  }
  if (gateway === undefined) throw new Error('browser gateway bundle did not register')
  browserGateway = gateway
  return gateway
}
