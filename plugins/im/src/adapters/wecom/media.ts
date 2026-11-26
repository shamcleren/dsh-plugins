import { decryptFile } from '@wecom/aibot-node-sdk'
import type { InboundMedia, WeComInboundText } from './inbound.js'
import type { PromptContentPart } from './host-api.js'

// Only the WeCom media account from the callback examples may supply quoted bytes.
const QUOTED_MEDIA_HOST = /^ww-aibot-(?:img|file)-1258476243\.cos\.[a-z0-9-]+\.myqcloud\.com$/u

/** Bound untrusted downloads before decryption and preserve the SDK's per-file key behavior. */
export async function inboundContent(message: WeComInboundText, maxBytes: number, signal: AbortSignal): Promise<PromptContentPart[]> {
  const result: PromptContentPart[] = message.text ? [{ type: 'text', text: message.text }] : []
  let remaining = maxBytes
  for (const media of message.media ?? []) {
    const received = await downloadMedia(media, remaining, signal)
    result.push(received.part)
    remaining -= received.size
  }
  const quote = message.quote
  if (quote === undefined) return result

  result.push({ type: 'text', text: quote.text ? `引用消息：\n${quote.text}` : '引用消息：' })
  let unavailable = quote.unavailableMedia
  const quoteSignal = quote.media.length ? AbortSignal.any([signal, AbortSignal.timeout(15_000)]) : signal
  for (const media of quote.media) {
    if (remaining === 0) { unavailable = true; break }
    try {
      const received = await downloadMedia(media, remaining, quoteSignal, true)
      result.push(received.part)
      remaining -= received.size
    } catch {
      signal.throwIfAborted()
      unavailable = true
      if (quoteSignal.aborted) break
    }
  }
  if (unavailable) result.push({ type: 'text', text: '[部分引用附件无法读取，可请发送者补发。]' })
  return result
}

async function downloadMedia(media: InboundMedia, maxBytes: number, signal: AbortSignal, quoted = false): Promise<{ part: PromptContentPart; size: number }> {
  const url = new URL(media.url)
  if (url.protocol !== 'https:') throw new Error('wecom-aibot: media URL must use HTTPS')
  if (quoted && (!QUOTED_MEDIA_HOST.test(url.hostname) || url.port || url.username || url.password)) {
    throw new Error('wecom-aibot: unsupported quoted attachment URL')
  }
  const response = await fetch(url, { signal: quoted ? signal : AbortSignal.any([signal, AbortSignal.timeout(120_000)]),
    ...(quoted ? { redirect: 'error' } : {}) })
  if (!response.ok || response.body === null) {
    await response.body?.cancel()
    throw new Error('wecom-aibot: media download failed')
  }
  const encryptedLimit = maxBytes + 32
  const declared = Number(response.headers.get('content-length'))
  if (Number.isFinite(declared) && declared > encryptedLimit) {
    await response.body.cancel()
    throw new Error('wecom-aibot: inbound media exceeds mediaMaxBytes')
  }
  const chunks: Buffer[] = [], reader = response.body.getReader()
  let length = 0
  try {
    while (true) {
      const chunk = await reader.read()
      if (chunk.done) break
      length += chunk.value.byteLength
      if (length > encryptedLimit) throw new Error('wecom-aibot: inbound media exceeds mediaMaxBytes')
      chunks.push(Buffer.from(chunk.value))
    }
  } finally { await reader.cancel(); reader.releaseLock() }
  signal.throwIfAborted()
  const encrypted = Buffer.concat(chunks, length)
  const bytes = media.key === undefined ? encrypted : decryptFile(encrypted, media.key)
  if (bytes.length > maxBytes) throw new Error('wecom-aibot: inbound media exceeds mediaMaxBytes')
  const disposition = response.headers.get('content-disposition') ?? ''
  const named = /filename\*?=(?:UTF-8'')?"?([^";]+)/iu.exec(disposition)?.[1]
  let name = media.kind === 'video' ? 'video.mp4' : 'attachment'
  if (named !== undefined) { try { name = decodeURIComponent(named).split(/[\\/]/u).at(-1) || name } catch { /* Keep the fallback on invalid encoding. */ } }
  const mediaType = bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) ? 'image/png'
    : bytes.subarray(0, 3).equals(Buffer.from([255, 216, 255])) ? 'image/jpeg'
    : bytes.subarray(0, 4).toString('ascii') === 'GIF8' ? 'image/gif'
    : bytes.subarray(0, 4).toString('ascii') === 'RIFF' && bytes.subarray(8, 12).toString('ascii') === 'WEBP' ? 'image/webp' : undefined
  const data = bytes.toString('base64')
  const part: PromptContentPart = media.kind === 'image' && mediaType !== undefined
    ? { type: 'image', mediaType, data } : { type: 'file-bytes', name, data }
  return { part, size: bytes.length }
}
