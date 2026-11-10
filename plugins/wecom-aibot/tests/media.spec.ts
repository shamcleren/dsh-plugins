import { afterEach, expect, it, vi } from 'vitest'
import { createCipheriv, randomBytes } from 'node:crypto'
import { inboundContent } from '../src/media.js'
import { normalizeTextFrame } from '../src/inbound.js'

afterEach(() => { vi.unstubAllGlobals() })
const identity = { msgid: 'one', aibotid: 'bot-one', chattype: 'single', from: { userid: 'one' } }

it('preserves voice transcription and quoted text', async () => {
  const message = normalizeTextFrame({ headers: { req_id: 'one' }, body: {
    ...identity, chattype: 'single', msgtype: 'voice', voice: { content: '语音正文' },
    quote: { msgtype: 'text', text: { content: '前文' } },
  } })
  await expect(inboundContent(message, 1024, new AbortController().signal)).resolves.toEqual([
    { type: 'text', text: '语音正文' }, { type: 'text', text: '引用消息：\n前文' },
  ])
})

it('decrypts inbound files with the SDK and preserves the display filename', async () => {
  const key = randomBytes(32), raw = Buffer.from('file-content')
  const padding = 32 - raw.length % 32
  const cipher = createCipheriv('aes-256-cbc', key, key.subarray(0, 16)); cipher.setAutoPadding(false)
  const encrypted = Buffer.concat([cipher.update(Buffer.concat([raw, Buffer.alloc(padding, padding)])), cipher.final()])
  vi.stubGlobal('fetch', vi.fn(async () => new Response(encrypted, { headers: { 'content-disposition': "attachment; filename*=UTF-8''report.txt" } })))
  const message = normalizeTextFrame({ headers: { req_id: 'one' }, body: {
    ...identity, chattype: 'single', msgtype: 'file', file: { url: 'https://cdn.example.test/file', aeskey: key.toString('base64') },
  } })
  await expect(inboundContent(message, 1024, new AbortController().signal)).resolves.toEqual([
    { type: 'text', text: '[企微附件]' }, { type: 'file-bytes', name: 'report.txt', data: raw.toString('base64') },
  ])
})

it('bounds media even without content-length and cancels the download', async () => {
  let cancelled = false
  vi.stubGlobal('fetch', vi.fn(async () => new Response(new ReadableStream({
    pull(controller) { controller.enqueue(new Uint8Array(512)) }, cancel() { cancelled = true },
  }))))
  const message = { messageId: 'one', botId: 'bot', userId: 'one', conversationId: 'one', chatType: 'single' as const,
    text: '[附件]', media: [{ kind: 'file' as const, url: 'https://cdn.example.test/file' }] }
  await expect(inboundContent(message, 1024, new AbortController().signal)).rejects.toThrow('exceeds')
  expect(cancelled).toBe(true)
})
