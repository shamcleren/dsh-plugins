import { describe, expect, it, vi } from 'vitest'
import { modelCommand, type ChannelCommandContext } from '../../src/core/channel-commands.js'
import type { HostApiProxy } from '../../src/core/host-api.js'

function createCommandContext(selectResult?: Awaited<ReturnType<HostApiProxy['sessions']['selectModel']>>) {
  const selectModel = vi.fn(async (req: Parameters<HostApiProxy['sessions']['selectModel']>[0]) => selectResult ?? {
    rpcId: req.rpcId,
    result: {
      ok: true as const,
      value: {
        selected: {
          provider: req.payload.provider,
          model: req.payload.model,
          ...(req.payload.reasoningEffort === undefined ? {} : { reasoningEffort: req.payload.reasoningEffort }),
        },
      },
    },
  })

  const api = {
    sessions: {
      models: vi.fn(async (req: { rpcId: string }) => ({
        rpcId: req.rpcId,
        result: {
          ok: true as const,
          value: {
            current: { provider: 'deepseek', model: 'deepseek-chat' },
            groups: [
              {
                id: 'deepseek',
                name: 'DeepSeek',
                models: [
                  { id: 'deepseek-chat', name: 'DeepSeek Chat' },
                  { id: 'shared-model', name: 'Shared' },
                ],
              },
              {
                id: 'magpie-responses',
                name: 'Magpie',
                models: [
                  {
                    id: 'codex/gpt-6.2-sol',
                    name: 'GPT 6.2 Sol',
                    reasoning: { efforts: [{ id: 'low', name: 'Low' }, { id: 'high', name: 'High' }] },
                  },
                  { id: 'shared-model', name: 'Shared' },
                ],
              },
            ],
          },
        },
      })),
      selectModel,
    },
  } as unknown as HostApiProxy

  const ctx: ChannelCommandContext = {
    api,
    rpcPrefix: 'wecom-api',
    sessionPrefix: 'session-wecom',
    localModelNotice: '此选择仅作用于当前企微会话。',
    defaultWorkspace: () => ({ workspaceId: 'ws-1', path: '/tmp/ws', title: 'Default', sessionIds: [] }),
    getAgentPreset: () => undefined,
    setAgentPreset: () => undefined,
    writeAgentPreset: async () => undefined,
    createSession: async id => id,
    bindSession: async () => undefined,
  }
  return { ctx, selectModel }
}

describe('modelCommand', () => {
  it('lists models with 1-based numbers and usage hint', async () => {
    const { ctx } = createCommandContext()
    const reply = await modelCommand(ctx, 'session-1', [])
    expect(reply).toContain('1. deepseek deepseek-chat')
    expect(reply).toContain('3. magpie-responses codex/gpt-6.2-sol [low, high]')
    expect(reply).toContain('/model <编号> [effort]')
  })

  it('switches models by 1-based index with optional effort', async () => {
    const { ctx, selectModel } = createCommandContext()
    const reply = await modelCommand(ctx, 'session-1', ['3', 'high'])
    expect(selectModel).toHaveBeenCalledWith(expect.objectContaining({
      payload: { sessionId: 'session-1', provider: 'magpie-responses', model: 'codex/gpt-6.2-sol', reasoningEffort: 'high' },
    }))
    expect(reply).toContain('已切换到 magpie-responses / codex/gpt-6.2-sol，Effort：high。')

    await expect(modelCommand(ctx, 'session-1', ['99'])).resolves.toContain('没有找到该编号对应的模型')
  })

  it('supports unique model id shorthand and rejects ambiguous model ids', async () => {
    const { ctx, selectModel } = createCommandContext()
    const reply = await modelCommand(ctx, 'session-1', ['codex/gpt-6.2-sol', 'low'])
    expect(selectModel).toHaveBeenCalledWith(expect.objectContaining({
      payload: { sessionId: 'session-1', provider: 'magpie-responses', model: 'codex/gpt-6.2-sol', reasoningEffort: 'low' },
    }))
    expect(reply).toContain('已切换到 magpie-responses / codex/gpt-6.2-sol，Effort：low。')

    await expect(modelCommand(ctx, 'session-1', ['shared-model'])).resolves.toContain('存在多个同名模型')
  })

  it('returns a safe actionable reply when selectModel fails with a HostApiError', async () => {
    const { ctx } = createCommandContext({
      rpcId: 'r1',
      result: { ok: false, error: { code: 'host-error', message: 'secret-token-should-not-leak' } },
    })
    const reply = await modelCommand(ctx, 'session-1', ['3'])
    expect(reply).toContain('该模型当前不可用')
    expect(reply).not.toContain('secret-token-should-not-leak')
  })
})
