import { Context } from '@deepseek-ai/cordis'
import { expect, it, vi } from 'vitest'
import { ConversationModels } from '../src/models.js'

it('keeps model routing and prompt assembly together without saving the Host default', async () => {
  const host = new Context(), scoped = new Context()
  const append = vi.fn(), selectModel = vi.fn()
  const agent = { id: 'session-one', ctx: scoped, session: { append } }
  host.provide('sessionController', {
    resolveAgent: async () => ({ agent }), selectModel,
    modelCatalog: async () => ({ groups: [{ id: 'provider', models: [{ id: 'first' }, { id: 'second' }] }] }),
  } as never)
  host.provide('llm', { resolveCallConfig: async (value: unknown) => value } as never)
  const models = new ConversationModels(host)
  try {
    await models.select('session-one', { provider: 'provider', model: 'first' })
    const assembly = await scoped.waterfall('system-prompt/assemble', {} as never, {} as never,
      async () => ({ variables: { provider: 'global', model: 'default' } }) as never)
    expect(assembly.variables).toMatchObject({ provider: 'provider', model: 'first' })
    await models.select('session-one', { provider: 'provider', model: 'second' })
    const request = await scoped.waterfall('agent/request', {} as never,
      async () => ({ provider: 'global', model: 'default', reasoningEffort: 'high' as never }))
    expect(request).toEqual({ provider: 'provider', model: 'first' })
    expect(models.current('session-one')).toEqual({ provider: 'provider', model: 'second' })
    expect(models.current('foreign')).toBeUndefined()
    expect(selectModel).not.toHaveBeenCalled()
    expect(append).toHaveBeenCalledWith('model/selection', { provider: 'provider', model: 'second' })
    await expect(models.select('session-one', { provider: 'provider', model: 'missing' })).rejects.toThrow('unavailable')
    await host.fiber.dispose()
    await expect(scoped.waterfall('agent/request', {} as never,
      async () => ({ provider: 'global', model: 'default' }))).resolves.toEqual({ provider: 'global', model: 'default' })
  } finally { await host.fiber.dispose(); await scoped.fiber.dispose() }
})
