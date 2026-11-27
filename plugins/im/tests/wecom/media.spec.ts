import { afterEach, expect, it, vi } from 'vitest'
import { createCipheriv, randomBytes } from 'node:crypto'
import { inboundContent } from '../../src/adapters/wecom/media.js'
import { normalizeTextFrame } from '../../src/adapters/wecom/inbound.js'

afterEach(() => { vi.unstubAllGlobals() })
const identity = { msgid: 'one', aibotid: 'bot-one', chattype: 'single', from: { userid: 'one' } }
const quotedImageUrl = 'https://ww-aibot-img-1258476243.cos.ap-guangzhou.myqcloud.com/synthetic-image'

it('preserves voice transcription and quoted text', async () => {
  const message = normalizeTextFrame({ headers: { req_id: 'one' }, body: {
    ...identity, chattype: 'single', msgtype: 'voice', voice: { content: '语音正文' },
    quote: { msgtype: 'text', text: { content: '前文' } },
  } })
  await expect(inboundContent(message, 1024, new AbortController().signal)).resolves.toEqual([
    { type: 'text', text: '语音正文' }, { type: 'text', text: '\n\n引用消息：\n前文' },
  ])
})

it('reads the text and encrypted image from a quoted mixed message with an empty reply', async () => {
  const image = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aG3sAAAAASUVORK5CYII=', 'base64')
  const key = randomBytes(32)
  const padding = 32 - image.length % 32
  const cipher = createCipheriv('aes-256-cbc', key, key.subarray(0, 16))
  cipher.setAutoPadding(false)
  const encrypted = Buffer.concat([cipher.update(Buffer.concat([image, Buffer.alloc(padding, padding)])), cipher.final()])
  const fetchMedia = vi.fn(async () => new Response(encrypted))
  vi.stubGlobal('fetch', fetchMedia)
  const message = normalizeTextFrame({ headers: { req_id: 'one' }, body: {
    ...identity, chattype: 'single', msgtype: 'text', text: { content: '' },
    quote: { msgtype: 'mixed', mixed: { msg_item: [
      { msgtype: 'image', image: { url: quotedImageUrl, aeskey: key.toString('base64') } },
      { msgtype: 'text', text: { content: '任务一直停在排队。' } },
    ] } },
  } })
  await expect(inboundContent(message, 1024, new AbortController().signal)).resolves.toEqual([
    { type: 'text', text: '引用消息：\n任务一直停在排队。' },
    { type: 'image', mediaType: 'image/png', data: image.toString('base64') },
  ])
  expect(fetchMedia).toHaveBeenCalledExactlyOnceWith(new URL(quotedImageUrl), expect.objectContaining({ redirect: 'error' }))
})

it('retains quoted text when attachment URLs are missing, expired or outside the permitted origins', async () => {
  const fetchMedia = vi.fn(async () => new Response(null, { status: 403 }))
  vi.stubGlobal('fetch', fetchMedia)
  const message = normalizeTextFrame({ headers: { req_id: 'one' }, body: {
    ...identity, chattype: 'single', msgtype: 'text', text: { content: '@Bot' },
    quote: { msgtype: 'mixed', mixed: { msg_item: [
      { msgtype: 'text', text: { content: '截图中的文字说明。' } },
      { msgtype: 'image' },
      { msgtype: 'image', image: { url: quotedImageUrl } },
      { msgtype: 'image', image: { url: 'https://media.example.invalid/quoted-image' } },
    ] } },
  } })
  await expect(inboundContent(message, 1024, new AbortController().signal)).resolves.toEqual([
    { type: 'text', text: '@Bot' },
    { type: 'text', text: '\n\n引用消息：\n截图中的文字说明。' },
    { type: 'text', text: '\n[部分引用附件无法读取，可请发送者补发。]' },
  ])
  expect(fetchMedia).toHaveBeenCalledExactlyOnceWith(new URL(quotedImageUrl), expect.objectContaining({ redirect: 'error' }))
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
