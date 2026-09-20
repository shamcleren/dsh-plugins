import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import type { RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import type { CredentialInfo } from '@deepseek-ai/dsh-credentials/types'
export interface CardApi {
  credentials: {
    describe(request: { refs: string[] }): Promise<{ result: RemoteResult<{ credentials: Record<string, CredentialInfo> }> }>
    set(request: { ref: string; value: string }): Promise<{ result: RemoteResult<void> }>
  }
  workspace: { list(request: object): Promise<{ result: RemoteResult<{ items: readonly { workspaceId: string; path: string; title: string }[] }> }> }
  presets: { list(request: object): Promise<{ result: RemoteResult<{ items: readonly PresetOption[]; defaultId?: string }> }> }
}

export interface PresetOption {
  id: string
  name?: string
  broken?: string
}

interface AgentPresetsRemote {
  list(): Promise<RemoteResult<{
    presets: readonly {
      id: string
      name?: string
      isDefault: boolean
      broken?: string
    }[]
  }>>
}
function agentPresets(ctx: Context): AgentPresetsRemote {
  return (ctx.remote as Context['remote'] & { agentPresets: AgentPresetsRemote }).agentPresets
}

export function cardApi(ctx: Context): CardApi {
  const lifetime = new AbortController()
  ctx.effect(() => () => lifetime.abort())
  return {
    credentials: {
      async describe({ refs }) { const result = await ctx.remote.credentials.describe(refs); return { result: result.ok ? { ok: true, value: { credentials: result.value } } : result } },
      async set({ ref, value }) { return { result: await ctx.remote.credentials.set(ref, value) } },
    },
    workspace: {
      async list() {
        const controller = new AbortController()
        try {
          for await (const frame of ctx.remote.workspace.follow(AbortSignal.any([lifetime.signal, controller.signal, AbortSignal.timeout(15000)]))) if (frame.type === 'baseline') return { result: { ok: true, value: { items: frame.value.items } } }
          throw new Error('Workspace baseline unavailable')
        } finally { controller.abort() }
      },
    },
    presets: {
      async list() {
        const result = await agentPresets(ctx).list()
        if (!result.ok) return { result }
        const defaultPreset = result.value.presets.find(preset => preset.isDefault)
        return { result: { ok: true, value: {
          items: result.value.presets.map(preset => ({
            id: preset.id,
            ...preset.name === undefined ? {} : { name: preset.name },
            ...preset.broken === undefined ? {} : { broken: preset.broken },
          })),
          ...defaultPreset === undefined ? {} : { defaultId: defaultPreset.id },
        } } }
      },
    },
  }
}
