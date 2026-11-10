import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto'
import { getUploadUrl } from './api.js'
import type { CdnMedia } from './protocol.js'
import { UploadMediaType } from './protocol.js'

function aesKey(encoded: string): Buffer {
  const decoded = Buffer.from(encoded, 'base64')
  if (decoded.length === 16) return decoded
  const text = decoded.toString('ascii')
  if (decoded.length === 32 && /^[0-9a-f]{32}$/iu.test(text)) return Buffer.from(text, 'hex')
  throw new Error(`wechat: media AES key has ${decoded.length} bytes; expected 16 raw bytes or 32 hex characters`)
}

function mediaUrl(media: CdnMedia, cdnBaseUrl: string): string {
  if (media.full_url !== undefined) return media.full_url
  if (media.encrypt_query_param === undefined) throw new Error('wechat: media has no download URL')
  return `${cdnBaseUrl}/download?encrypted_query_param=${encodeURIComponent(media.encrypt_query_param)}`
}

async function boundedBytes(url: string, maxBytes: number, signal?: AbortSignal): Promise<Buffer> {
  const response = await fetch(url, { signal: AbortSignal.any([AbortSignal.timeout(120_000), ...signal ? [signal] : []]) })
  if (!response.ok) throw new Error(`wechat: media download returned HTTP ${response.status}`)
  const declared = Number(response.headers.get('content-length'))
  if (Number.isFinite(declared) && declared > maxBytes) {
    await response.body?.cancel()
    throw new Error(`wechat: media exceeds ${maxBytes} bytes`)
  }
  if (response.body === null) return Buffer.alloc(0)
  const reader = response.body.getReader(), chunks: Buffer[] = []
  let length = 0
  try {
    while (true) {
      const chunk = await reader.read()
      if (chunk.done) return Buffer.concat(chunks, length)
      length += chunk.value.byteLength
      if (length > maxBytes) throw new Error(`wechat: media exceeds ${maxBytes} bytes`)
      chunks.push(Buffer.from(chunk.value))
    }
  } finally { await reader.cancel(); reader.releaseLock() }
}

/** Download and decrypt one iLink CDN object with AES-128-ECB. */
export async function downloadMedia(
  media: CdnMedia,
  key: string | undefined,
  cdnBaseUrl: string,
  maxBytes: number,
  signal?: AbortSignal,
): Promise<Buffer> {
  const encrypted = await boundedBytes(mediaUrl(media, cdnBaseUrl), maxBytes + (key === undefined ? 0 : 16), signal)
  if (key === undefined) return encrypted
  const decipher = createDecipheriv('aes-128-ecb', aesKey(key), null)
  const plaintext = Buffer.concat([decipher.update(encrypted), decipher.final()])
  if (plaintext.length > maxBytes) throw new Error(`wechat: decrypted media exceeds ${maxBytes} bytes`)
  return plaintext
}

function uploadUrl(reservation: { upload_full_url?: string; upload_param?: string }, cdnBaseUrl: string, fileKey: string): string {
  if (reservation.upload_full_url?.trim()) return reservation.upload_full_url.trim()
  if (!reservation.upload_param) throw new Error('wechat: getuploadurl returned no upload target')
  return `${cdnBaseUrl}/upload?encrypted_query_param=${encodeURIComponent(reservation.upload_param)}&filekey=${encodeURIComponent(fileKey)}`
}

/** Both key encodings accepted by iLink decode to the same AES-128 key. */
export interface MediaUploadRequest {
  baseUrl: string
  token: string
  userId: string
  bytes: Buffer
  cdnBaseUrl: string
  signal?: AbortSignal
}

/** Encrypt and upload a bounded media object; never retry an ambiguous send. */
export async function uploadMedia(request: MediaUploadRequest & {
  mediaType: typeof UploadMediaType[keyof typeof UploadMediaType]
}): Promise<{ media: CdnMedia; ciphertextSize: number }> {
  const key = randomBytes(16)
  const fileKey = randomBytes(16).toString('hex')
  const signal = AbortSignal.any([AbortSignal.timeout(120_000), ...(request.signal ? [request.signal] : [])])
  signal.throwIfAborted()
  const cipher = createCipheriv('aes-128-ecb', key, null)
  const ciphertext = Buffer.concat([cipher.update(request.bytes), cipher.final()])
  const reservation = await getUploadUrl({
    baseUrl: request.baseUrl,
    token: request.token,
    userId: request.userId,
    fileKey,
    mediaType: request.mediaType,
    rawSize: request.bytes.length,
    rawFileMd5: createHash('md5').update(request.bytes).digest('hex'),
    fileSize: ciphertext.length,
    aesKeyHex: key.toString('hex'),
    signal,
  })
  const response = await fetch(uploadUrl(reservation, request.cdnBaseUrl, fileKey), {
    method: 'POST',
    headers: { 'Content-Type': 'application/octet-stream' },
    body: new Uint8Array(ciphertext),
    signal,
  })
  if (response.status !== 200) throw new Error(`wechat: media upload returned HTTP ${response.status}`)
  const encryptedParam = response.headers.get('x-encrypted-param')
  if (encryptedParam === null || encryptedParam === '') {
    throw new Error('wechat: media upload returned no x-encrypted-param')
  }
  return {
    media: { encrypt_query_param: encryptedParam, aes_key: key.toString('base64'), encrypt_type: 1 },
    ciphertextSize: ciphertext.length,
  }
}

/** Preserve the image sender's reference and ciphertext-size contract. */
export async function uploadImage(request: MediaUploadRequest): Promise<{ media: CdnMedia; midSize: number }> {
  const uploaded = await uploadMedia({ ...request, mediaType: UploadMediaType.IMAGE })
  return { media: uploaded.media, midSize: uploaded.ciphertextSize }
}
