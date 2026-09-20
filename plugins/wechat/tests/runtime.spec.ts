import type { Logger } from '@deepseek-ai/cordis'
import { describe, expect, it, vi } from 'vitest'
import type { HostApiProxy } from '../src/host-api.js'
import { WeChatRuntimeController } from '../src/runtime.js'
import type { WeChatAccountStore } from '../src/storage.js'

const observed = vi.hoisted(() => ({
  started: 0,
  stopped: 0,
  presets: [] as Array<string | undefined>,
}))

vi.mock('../src/account.js', () => ({
  WeChatAccount: class {
    start(): void { observed.started += 1 }
    async stop(): Promise<void> { observed.stopped += 1 }
  },
}))

vi.mock('../src/router.js', () => ({
  WeChatConversationRouter: class {
    setAgentPreset(next: string | undefined): void { observed.presets.push(next) }
    start(): void {}
    async stop(): Promise<void> {}
  },
}))

function logger(): Logger {
  return { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), success: vi.fn() } as unknown as Logger
}

describe('WeChatRuntimeController', () => {
  it('adopts a preset change without restarting bound accounts', async () => {
    observed.started = 0
    observed.stopped = 0
    observed.presets = []
    const store = {
      accounts: () => [{ accountId: 'account-a', userId: 'owner', token: 'token', baseUrl: 'https://example.invalid' }],
    } as unknown as WeChatAccountStore
    const runtime = new WeChatRuntimeController({
      api: {} as HostApiProxy,
      logger: logger(),
      store,
      prepareContext: async () => ({
        bindings: { current: (_key: string, fallback: string) => fallback, set: async () => undefined },
        defaultWorkspace: { workspaceId: 'workspace-a', path: '/tmp', title: '微信', sessionIds: [] },
      }),
      writeSettings: async () => undefined,
    })

    runtime.update({ agentPreset: 'standard' })
    await vi.waitFor(() => { expect(observed.started).toBe(1) })
    runtime.update({ agentPreset: 'dsh-security-audit' })
    await vi.waitFor(() => { expect(observed.presets).toContain('dsh-security-audit') })

    expect(observed.started).toBe(1)
    expect(observed.stopped).toBe(0)
    await runtime.stop()
  })
})
