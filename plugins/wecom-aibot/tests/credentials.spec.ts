import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it, vi } from 'vitest'
import { resolveCredentials } from '../src/credentials.js'

describe('WeCom credential resolution', () => {
  it('reads both configured references from the Host credential service', async () => {
    const ctx = new Context()
    const resolve = vi.fn(async (ref: string) => ({ value: `${ref}-value` }))
    ctx.provide('credentials', { resolve })

    await expect(resolveCredentials(ctx, { botIdEnv: 'BOT', secretEnv: 'SECRET' }))
      .resolves.toEqual({ botId: 'BOT-value', secret: 'SECRET-value' })
    expect(resolve.mock.calls).toEqual([['BOT'], ['SECRET']])
  })

  it('returns unavailable until both credential references resolve', async () => {
    const ctx = new Context()
    ctx.provide('credentials', {
      resolve: async (ref: string) => ref === 'BOT' ? { value: 'bot-id' } : undefined,
    })

    await expect(resolveCredentials(ctx, { botIdEnv: 'BOT', secretEnv: 'SECRET' }))
      .resolves.toBeUndefined()
  })
})
