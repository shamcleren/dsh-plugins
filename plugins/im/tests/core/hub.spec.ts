import { Context } from '@deepseek-ai/cordis'
import { expect, it } from 'vitest'
import { IMHub, type IMCapability } from '../../src/hub.js'
import { adapterViewsSchema } from '../../src/contracts.js'

it('owns immutable adapter identities, bounds public state and releases registrations', async () => {
  const ctx = new Context(), hub = new IMHub(ctx)
  try {
    const capabilities: IMCapability[] = ['text']
    const adapter = { id: 'wechat', capabilities, state: () => ({ enabled: true, status: 'running' as const, accounts: 1, privateCredential: 'fixture-private' }) }
    const remove = hub.register(adapter)
    adapter.id = 'changed'; capabilities.push('file')
    hub.report('wechat', 'host')
    expect(hub.state()[0]).toMatchObject({ id: 'wechat', capabilities: ['text'], lastFailure: { kind: 'host' } })
    expect(JSON.stringify(hub.state())).not.toContain('fixture-private')
    expect(() => hub.register({ ...adapter, id: 'wechat' })).toThrow(/duplicate/)
    remove()
    hub.register({ ...adapter, id: 'wechat' })
    remove()
    expect(hub.state()).toHaveLength(1)
    expect(hub.state()[0]?.lastFailure).toBeUndefined()
    hub.register({ id: 'broken', capabilities: [], state() { throw new Error('fixture-private') } })
    hub.register({ id: 'invalid', capabilities: [], state: () => ({ enabled: false, status: 'running', accounts: -1 }) })
    expect(hub.state().filter(item => item.status === 'failed')).toHaveLength(2)
    expect(adapterViewsSchema.safeParse(hub.state()).success).toBe(true)
    expect(adapterViewsSchema.safeParse([{ id: 'unknown', enabled: true, status: 'unknown', accounts: 1, capabilities: [] }]).success).toBe(false)
  } finally { await ctx.fiber.dispose() }
  expect(hub.state()).toEqual([])
})
