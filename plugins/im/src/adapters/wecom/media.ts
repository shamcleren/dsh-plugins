import { decryptFile } from '@wecom/aibot-node-sdk'
import type { WeComInboundText } from './inbound.js'
import type { PromptContentPart } from './host-api.js'

/** Bound untrusted downloads before decryption and preserve the SDK's per-file key behavior. */
export async function inboundContent(message: WeComInboundText, maxBytes: number, signal: AbortSignal): Promise<PromptContentPart[]> {
  const result: PromptContentPart[] = [{ type: 'text', text: message.text }]
  if (message.quote !== undefined) result.push({ type: 'text', text: `引用消息：\n${message.quote}` })
  let total = 0
  for (const media of message.media ?? []) {
    const url = new URL(media.url)
    if (url.protocol !== 'https:') throw new Error('wecom-aibot: media URL must use HTTPS')
    const response = await fetch(url, { signal: AbortSignal.any([signal, AbortSignal.timeout(120_000)]) })
    if (!response.ok || response.body === null) throw new Error('wecom-aibot: media download failed')
    const encryptedLimit = maxBytes - total + 32
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
    total += bytes.length
    if (total > maxBytes) throw new Error('wecom-aibot: inbound media exceeds mediaMaxBytes')
    const disposition = response.headers.get('content-disposition') ?? ''
    const named = /filename\*?=(?:UTF-8'')?"?([^";]+)/iu.exec(disposition)?.[1]
    let name = media.kind === 'video' ? 'video.mp4' : 'attachment'
    if (named !== undefined) { try { name = decodeURIComponent(named).split(/[\\/]/u).at(-1) || name } catch { /* Keep the fallback on invalid encoding. */ } }
    const mediaType = bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) ? 'image/png'
      : bytes.subarray(0, 3).equals(Buffer.from([255, 216, 255])) ? 'image/jpeg'
      : bytes.subarray(0, 4).toString('ascii') === 'GIF8' ? 'image/gif'
      : bytes.subarray(0, 4).toString('ascii') === 'RIFF' && bytes.subarray(8, 12).toString('ascii') === 'WEBP' ? 'image/webp' : undefined
    if (media.kind === 'image' && mediaType !== undefined) {
      result.push({ type: 'image', mediaType, data: bytes.toString('base64') })
    } else result.push({ type: 'file-bytes', name, data: bytes.toString('base64') })
  }
  return result
}
