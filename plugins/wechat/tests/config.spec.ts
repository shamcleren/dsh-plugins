import { describe, expect, it } from 'vitest'
import { Config, resolveRuntimeConfig } from '../src/config.js'

describe('WeChat automatic configuration', () => {
  it('derives management identity from QR ownership without a chat allowlist', () => {
    expect(resolveRuntimeConfig({}, 'owner-a')).toMatchObject({ adminUsers: ['owner-a'] })
    expect(resolveRuntimeConfig({}, 'owner-b')).toMatchObject({ adminUsers: ['owner-b'] })
    expect(resolveRuntimeConfig({})).not.toHaveProperty('allowedUsers')
  })
  it('retired toggles and ID settings cannot affect the runtime', () => {
    const config = Config(JSON.parse('{"enabled":false,"accountIds":["old"],"allowedUsers":["old"],"adminUsers":["old"]}'))
    expect(resolveRuntimeConfig(config, 'owner')).toMatchObject({ adminUsers: ['owner'] })
    expect(resolveRuntimeConfig(config, 'owner')).not.toHaveProperty('allowedUsers')
  })
  it('retains fixed operational defaults', () => {
    expect(resolveRuntimeConfig({})).toMatchObject({ adminUsers: [], mediaMaxBytes: 20 * 1024 * 1024, sendTyping: true, turnTimeoutMs: 300_000 })
  })
})
