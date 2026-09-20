import { describe, expect, it } from 'vitest'
import {
  assertCompanionMessage,
  createMessage,
  encodeMessage,
  MessageKind,
  PROTOCOL_VERSION,
} from '../src/protocol.js'

describe('protocol', () => {
  it('encodes a newline-terminated JSON message', () => {
    const message = createMessage(MessageKind.STATE, { state: 'idle' })
    const encoded = encodeMessage(message)
    expect(encoded.endsWith('\n')).toBe(true)
    const parsed = JSON.parse(encoded) as Record<string, unknown>
    expect(parsed.protocolVersion).toBe(PROTOCOL_VERSION)
    expect(parsed.kind).toBe('state')
    expect(parsed.state).toBe('idle')
  })

  it('round-trips through assertCompanionMessage', () => {
    const message = createMessage(MessageKind.CONFIG, { hostPid: 4242, petSize: 112 })
    const parsed = JSON.parse(encodeMessage(message)) as unknown
    expect(assertCompanionMessage(parsed)).toEqual(message)
  })

  it('round-trips an activate message with a session id', () => {
    const message = createMessage(MessageKind.ACTIVATE, { sessionId: 's-42' })
    const parsed = JSON.parse(encodeMessage(message)) as unknown
    expect(assertCompanionMessage(parsed)).toEqual(message)
  })

  it('rejects messages with an unknown kind or wrong version', () => {
    expect(assertCompanionMessage({ protocolVersion: PROTOCOL_VERSION, kind: 'nope' })).toBeNull()
    expect(assertCompanionMessage({ protocolVersion: 999, kind: 'state' })).toBeNull()
    expect(assertCompanionMessage(null)).toBeNull()
    expect(assertCompanionMessage([])).toBeNull()
  })
})
