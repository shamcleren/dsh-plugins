import { EventEmitter } from 'node:events'
import type { Logger } from '@deepseek-ai/cordis'
import type { TemplateCard, WsFrame } from '@wecom/aibot-node-sdk'
import { describe, expect, it, vi } from 'vitest'
import type { WeComBotClient } from '../src/account.js'
import type { HostApiProxy, RpcRequest } from '../src/host-api.js'
import { WeComRuntimeController } from '../src/runtime.js'
import type { WeComReplyClient } from '../src/router.js'

class FakeClient extends EventEmitter implements WeComBotClient, WeComReplyClient {
  connect = vi.fn()
  disconnect = vi.fn()

  async replyStream(): Promise<WsFrame> {
    return {} as WsFrame
  }

  async replyStreamNonBlocking(): Promise<WsFrame | 'skipped'> {
    return {} as WsFrame
  }

  async sendMessage(): Promise<WsFrame> {
    return {} as WsFrame
  }

  async updateTemplateCard(_frame: unknown, _templateCard: TemplateCard): Promise<WsFrame> {
    return {} as WsFrame
  }

  async uploadMedia(): Promise<{ media_id: string }> {
    return { media_id: 'media-1' }
  }

  async sendMediaMessage(): Promise<WsFrame> {
    return {} as WsFrame
  }
}

function logger(): Logger {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    success: vi.fn(),
  } as unknown as Logger
}

function api(): HostApiProxy {
  return {
    workspace: { list: vi.fn(), create: vi.fn(), rename: vi.fn() },
    sessions: {
      create: vi.fn(),
      history: vi.fn(),
      prompt: vi.fn(),
      models: vi.fn(),
      selectModel: vi.fn(),
    },
    events: {
      async *mux(_request: RpcRequest<Record<string, never>>, signal: AbortSignal) {
        await new Promise<void>((resolve) => {
          if (signal.aborted) resolve()
          else signal.addEventListener('abort', () => { resolve() }, { once: true })
        })
      },
    },
  } as unknown as HostApiProxy
}

const writeSettings = async () => undefined

const prepareContext = async () => ({
  defaultWorkspace: {
    workspaceId: 'workspace-wecom',
    title: '企业微信机器人',
    path: '/workspaces/wecom',
    sessionIds: [],
  },
  bindings: {
    current: (_key: string, fallback: string) => fallback,
    set: async () => undefined,
  },
})

describe('WeComRuntimeController', () => {
  it('connects once both credentials resolve and warns once while they are missing', async () => {
    const clients: FakeClient[] = []
    const sink = logger()
    let configured = false
    const runtime = new WeComRuntimeController({
      api: api(),
      logger: sink,
      resolveCredentials: async () => configured
        ? { botId: 'bot-id', secret: 'secret' }
        : undefined,
      createClient: () => {
        const client = new FakeClient()
        clients.push(client)
        return client
      },
      prepareContext,
      writeSettings,
    })

    runtime.update({})
    runtime.update({ allowedUsers: ['zhangsan'] })
    await vi.waitFor(() => { expect(sink.warn).toHaveBeenCalledTimes(1) })
    expect(clients).toEqual([])

    configured = true
    runtime.update({ allowedUsers: ['zhangsan'] })
    await vi.waitFor(() => { expect(clients[0]?.connect).toHaveBeenCalledTimes(1) })

    configured = false
    runtime.update({ allowedUsers: ['zhangsan'] })
    await vi.waitFor(() => { expect(clients[0]?.disconnect).toHaveBeenCalledTimes(1) })
    expect(sink.warn).toHaveBeenCalledTimes(2)
    await runtime.stop()
  })

  it('ignores a retired enabled flag left in an existing settings document', async () => {
    const clients: FakeClient[] = []
    const runtime = new WeComRuntimeController({
      api: api(),
      logger: logger(),
      resolveCredentials: async () => ({ botId: 'bot-id', secret: 'secret' }),
      createClient: () => {
        const client = new FakeClient()
        clients.push(client)
        return client
      },
      prepareContext,
      writeSettings,
    })

    runtime.update({ enabled: false } as never)
    await vi.waitFor(() => { expect(clients[0]?.connect).toHaveBeenCalledTimes(1) })
    await runtime.stop()
  })

  it('does not restart an unchanged active connection', async () => {
    const clients: FakeClient[] = []
    const resolveCredentials = vi.fn(async () => ({ botId: 'bot-id', secret: 'secret' }))
    const runtime = new WeComRuntimeController({
      api: api(),
      logger: logger(),
      resolveCredentials,
      createClient: () => {
        const client = new FakeClient()
        clients.push(client)
        return client
      },
      prepareContext,
      writeSettings,
    })

    runtime.update({})
    await vi.waitFor(() => { expect(clients).toHaveLength(1) })
    runtime.update({})
    await vi.waitFor(() => { expect(resolveCredentials).toHaveBeenCalledTimes(2) })

    expect(clients).toHaveLength(1)
    expect(clients[0]?.disconnect).not.toHaveBeenCalled()
    await runtime.stop()
  })

  it('adopts a preset change without reopening the connection', async () => {
    const clients: FakeClient[] = []
    const runtime = new WeComRuntimeController({
      api: api(),
      logger: logger(),
      resolveCredentials: async () => ({ botId: 'bot-id', secret: 'secret' }),
      createClient: () => {
        const client = new FakeClient()
        clients.push(client)
        return client
      },
      prepareContext,
      writeSettings,
    })

    runtime.update({ agentPreset: 'standard' })
    await vi.waitFor(() => { expect(clients).toHaveLength(1) })
    // `/preset` persists through settings, which reconciles us back synchronously;
    // a reconnect here would tear down the socket carrying the command's reply.
    runtime.update({ agentPreset: 'dsh-security-audit' })
    await vi.waitFor(() => { expect(clients[0]?.connect).toHaveBeenCalledTimes(1) })

    expect(clients).toHaveLength(1)
    expect(clients[0]?.disconnect).not.toHaveBeenCalled()
    await runtime.stop()
  })
})


it('isolates Bot credentials, workspaces and models, and only disconnects the removed Bot', async () => {
  const clients: FakeClient[] = []
  const contexts: unknown[] = []
  const runtime = new WeComRuntimeController({
    api: api(), logger: logger(), writeSettings,
    resolveCredentials: async config => config.secretEnv === 'missing' ? undefined
      : { botId: config.botIdEnv ?? '', secret: 'test-secret' },
    createClient: () => { const client = new FakeClient(); clients.push(client); return client },
    prepareContext: async config => { contexts.push(config); return prepareContext() },
  })
  const alpha = { id: 'alpha', workspaceId: 'workspace-alpha', model: { provider: 'one', model: 'a' } }
  const beta = { id: 'beta', workspaceId: 'workspace-beta', model: { provider: 'two', model: 'b' } }
  runtime.update({ bots: [alpha, beta, { id: 'offline', secretEnv: 'missing' }] })
  await runtime.ready()
  expect(clients).toHaveLength(2)
  expect(contexts).toEqual(expect.arrayContaining([
    expect.objectContaining({ botIdEnv: 'WECOM_alpha_BOT_ID', ...alpha }),
    expect.objectContaining({ botIdEnv: 'WECOM_beta_BOT_ID', ...beta }),
  ]))
  runtime.update({ bots: [beta] })
  await runtime.ready()
  expect(clients[0]?.disconnect).toHaveBeenCalledTimes(1)
  expect(clients[1]?.disconnect).not.toHaveBeenCalled()
  expect(clients).toHaveLength(2)
  runtime.update({ bots: [] })
  await runtime.ready()
  expect(clients[1]?.disconnect).toHaveBeenCalledTimes(1)
  await runtime.stop()
})

it('rejects a duplicate or unsafe roster before replacing current connections', async () => {
  const sink = logger(), client = new FakeClient()
  const runtime = new WeComRuntimeController({ api: api(), logger: sink, writeSettings,
    resolveCredentials: async () => ({ botId: 'test', secret: 'test' }), createClient: () => client, prepareContext })
  runtime.update({ bots: [{ id: 'alpha' }] }); await runtime.ready()
  runtime.update({ bots: [{ id: 'same' }, { id: 'same' }] }); await runtime.ready()
  runtime.update({ bots: [{ id: '../unsafe' }] }); await runtime.ready()
  expect(sink.error).toHaveBeenCalledTimes(2)
  expect(client.disconnect).not.toHaveBeenCalled()
  await runtime.stop()
})

it('keeps duplicate actual Bot accounts offline even when their credential references differ', async () => {
  const client = new FakeClient(), sink = logger(), createClient = vi.fn(() => client)
  const runtime = new WeComRuntimeController({ api: api(), logger: sink, writeSettings, prepareContext,
    resolveCredentials: async () => ({ botId: 'same-account', secret: 'test' }), createClient })
  runtime.update({ bots: [{ id: 'alpha' }, { id: 'beta' }] }); await runtime.ready()
  expect(createClient).not.toHaveBeenCalled()
  expect(sink.error).toHaveBeenCalledTimes(2)
  runtime.update({ bots: [{ id: 'alpha' }] }); await runtime.ready()
  expect(client.connect).toHaveBeenCalledTimes(1)
  await runtime.stop()
})
