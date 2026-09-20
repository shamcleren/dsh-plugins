import { describe, expect, it } from 'vitest'
import {
  DEFAULT_THINKING_TEXT,
  DEFAULT_TURN_TIMEOUT_MS,
  resolveRuntimeConfig,
} from '../src/config.js'

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
