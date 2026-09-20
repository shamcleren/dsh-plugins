import { describe, expect, it } from 'vitest'
import { conversationKeyFor, normalizeInboundMessage, promptRpcIdFor, sessionIdFor } from '../src/inbound.js'
import { MessageItemType } from '../src/protocol.js'

describe('inbound WeChat normalization', () => {
  it('preserves text, voice transcription, and file notice in one prompt', async () => {
    const message = await normalizeInboundMessage('bot-a', {
      client_id: 'message-a',
      from_user_id: 'peer-a',
      context_token: 'context-a',
      item_list: [
        { type: MessageItemType.TEXT, text_item: { text: '请总结' } },
        { type: MessageItemType.VOICE, voice_item: { text: '语音正文' } },
        { type: MessageItemType.FILE, file_item: { file_name: 'report.pdf' } },
      ],
    }, 1024)

    expect(message).toMatchObject({
      accountId: 'bot-a', messageId: 'message-a', userId: 'peer-a', contextToken: 'context-a',
      content: [
        { type: 'text', text: '请总结' },
        { type: 'text', text: '语音正文' },
        { type: 'text', text: '[微信文件：report.pdf]' },
      ],
    })
  })

  it('isolates accounts and peers while keeping identities deterministic', async () => {
    const first = await normalizeInboundMessage('bot-a', {
      message_id: 7, from_user_id: 'peer-a', item_list: [{ type: 1, text_item: { text: 'hi' } }],
    }, 1024)
    const same = await normalizeInboundMessage('bot-a', {
      message_id: 7, from_user_id: 'peer-a', item_list: [{ type: 1, text_item: { text: 'hi' } }],
    }, 1024)
    const other = await normalizeInboundMessage('bot-b', {
      message_id: 7, from_user_id: 'peer-a', item_list: [{ type: 1, text_item: { text: 'hi' } }],
    }, 1024)

    expect(conversationKeyFor(first)).toBe(conversationKeyFor(same))
    expect(sessionIdFor(first)).not.toBe(sessionIdFor(other))
    expect(promptRpcIdFor(first)).not.toBe(promptRpcIdFor(other))
  })
})
