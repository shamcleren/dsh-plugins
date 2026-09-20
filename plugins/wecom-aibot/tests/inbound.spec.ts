import { MessageType } from '@wecom/aibot-node-sdk'
import { describe, expect, it } from 'vitest'
import {
  normalizeTextFrame,
  promptRpcIdFor,
  sessionIdFor,
} from '../src/inbound.js'
import type { WeComTextFrame } from '../src/inbound.js'

function frame(overrides: Record<string, unknown> = {}): WeComTextFrame {
  return {
    headers: { req_id: 'request' },
    body: {
      msgid: 'message-1',
      aibotid: 'bot-1',
      chattype: 'single',
      from: { userid: 'user-1' },
      msgtype: MessageType.Text,
      text: { content: 'hello' },
      ...overrides,
    },
  } as WeComTextFrame
}

describe('WeCom inbound routing', () => {
  it('isolates direct conversations without exposing the userid in the session id', () => {
    const message = normalizeTextFrame(frame())

    expect(message.conversationId).toBe('user-1')
    expect(sessionIdFor(message)).toMatch(/^session-wecom-[a-f0-9]{64}$/)
    expect(sessionIdFor(message)).not.toContain('user-1')
    expect(promptRpcIdFor(message)).toBe(promptRpcIdFor(normalizeTextFrame(frame())))
  })

  it('routes every member of one group to the group conversation', () => {
    const first = normalizeTextFrame(frame({
      chattype: 'group',
      chatid: 'group-1',
    }))
    const second = normalizeTextFrame(frame({
      msgid: 'message-2',
      chattype: 'group',
      chatid: 'group-1',
      from: { userid: 'user-2' },
    }))

    expect(sessionIdFor(first)).toBe(sessionIdFor(second))
  })

  it('rejects a group frame without a chat id', () => {
    expect(() => normalizeTextFrame(frame({ chattype: 'group' }))).toThrow('missing chatid')
  })
})
