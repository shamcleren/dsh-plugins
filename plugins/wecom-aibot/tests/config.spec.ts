import { describe, expect, it } from 'vitest'
import {
  DEFAULT_THINKING_TEXT,
  DEFAULT_TURN_TIMEOUT_MS,
  Config,
  configuredBots,
  resolveRuntimeConfig,
} from '../src/config.js'
import type { Config as PlainConfig } from '../src/config.js'

describe('resolveRuntimeConfig', () => {
  it('resolves the channel policy defaults without enabling a connection', () => {
    expect(resolveRuntimeConfig({})).toEqual({
      allowedUsers: [],
      adminUsers: [],
      thinkingText: DEFAULT_THINKING_TEXT,
      turnTimeoutMs: DEFAULT_TURN_TIMEOUT_MS,
    })
  })
})

it('inherits the Host model for schema-resolved single and multiple Bots, including saved empty objects', () => {
  expect(resolveRuntimeConfig(Config({})).model).toBeUndefined()
  const bots = configuredBots(Config({ bots: [{ id: 'alpha', model: {} }, { id: 'beta' }] } as unknown as PlainConfig))
  expect(bots.map(bot => resolveRuntimeConfig(bot).model)).toEqual([undefined, undefined])
})

it('preserves independent complete model choices and rejects partial choices before connecting', () => {
  const alpha = { provider: 'provider-a', model: 'model-a' }
  const beta = { provider: 'provider-b', model: 'model-b', reasoningEffort: 'high' }
  expect(configuredBots(Config({ bots: [{ id: 'alpha', model: alpha }, { id: 'beta', model: beta }] }))
    .map(bot => resolveRuntimeConfig(bot).model)).toEqual([alpha, beta])
  for (const model of [{ provider: 'p' }, { model: 'm' }, { reasoningEffort: 'high' }]) {
    const config = Config({ model } as unknown as PlainConfig)
    expect(() => resolveRuntimeConfig(config)).toThrow('requires both provider and model')
  }
})

it('keeps nested Bot credential defaults independent after schema resolution', async () => {
  const { Config, configuredBots } = await import('../src/config.js')
  const config = Config({ bots: [{ id: 'alpha' }, { id: 'beta' }] })
  expect(configuredBots(config).map(bot => [bot.botIdEnv, bot.secretEnv])).toEqual([
    ['WECOM_alpha_BOT_ID', 'WECOM_alpha_BOT_SECRET'], ['WECOM_beta_BOT_ID', 'WECOM_beta_BOT_SECRET'],
  ])
})
