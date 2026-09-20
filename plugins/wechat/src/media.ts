import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from 'node:crypto'
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

async function boundedBytes(url: string, maxBytes: number): Promise<Buffer> {
  const response = await fetch(url)
  if (!response.ok) throw new Error(`wechat: media download returned HTTP ${response.status}`)
  const declared = Number(response.headers.get('content-length'))
  if (Number.isFinite(declared) && declared > maxBytes) throw new Error(`wechat: media exceeds ${maxBytes} bytes`)
  const bytes = Buffer.from(await response.arrayBuffer())
  if (bytes.length > maxBytes) throw new Error(`wechat: media exceeds ${maxBytes} bytes`)
  return bytes
}

/** Download and decrypt one iLink CDN object with AES-128-ECB. */
export async function downloadMedia(
  media: CdnMedia,
  key: string | undefined,
  cdnBaseUrl: string,
  maxBytes: number,
): Promise<Buffer> {
  const encrypted = await boundedBytes(mediaUrl(media, cdnBaseUrl), maxBytes)
  if (key === undefined) return encrypted
  const decipher = createDecipheriv('aes-128-ecb', aesKey(key), null)
  const plaintext = Buffer.concat([decipher.update(encrypted), decipher.final()])
  if (plaintext.length > maxBytes) throw new Error(`wechat: decrypted media exceeds ${maxBytes} bytes`)
  return plaintext
}

function uploadUrl(reservation: { upload_full_url?: string; upload_param?: string }, cdnBaseUrl: string): string {
  if (reservation.upload_full_url !== undefined) return reservation.upload_full_url
  if (reservation.upload_param === undefined) throw new Error('wechat: getuploadurl returned no upload target')
  return `${cdnBaseUrl}/upload?${reservation.upload_param}`
}

/**
 * Encrypt one image, publish it to the iLink CDN and return the reference an
 * outbound `image_item` needs. This is the inverse of `downloadMedia`: the peer
 * decrypts with the key carried in the reference, so the key travels as raw bytes
 * in base64 while `getuploadurl` wants the same key as hex.
 */
export async function uploadImage(request: {
  baseUrl: string
  token: string
  userId: string
  bytes: Buffer
  cdnBaseUrl: string
  signal?: AbortSignal
}): Promise<{ media: CdnMedia; midSize: number }> {
  const key = randomBytes(16)
  const cipher = createCipheriv('aes-128-ecb', key, null)
  const ciphertext = Buffer.concat([cipher.update(request.bytes), cipher.final()])
  const reservation = await getUploadUrl({
    baseUrl: request.baseUrl,
    token: request.token,
    userId: request.userId,
    fileKey: randomUUID(),
    mediaType: UploadMediaType.IMAGE,
    rawSize: request.bytes.length,
    rawFileMd5: createHash('md5').update(request.bytes).digest('hex'),
    fileSize: ciphertext.length,
    aesKeyHex: key.toString('hex'),
    ...request.signal === undefined ? {} : { signal: request.signal },
  })
  const response = await fetch(uploadUrl(reservation, request.cdnBaseUrl), {
    method: 'POST',
    headers: { 'Content-Type': 'application/octet-stream' },
    body: new Uint8Array(ciphertext),
    ...request.signal === undefined ? {} : { signal: request.signal },
  })
  if (!response.ok) throw new Error(`wechat: media upload returned HTTP ${response.status}`)
  const encryptedParam = response.headers.get('x-encrypted-param')
  if (encryptedParam === null || encryptedParam === '') {
    throw new Error('wechat: media upload returned no x-encrypted-param')
  }
  return {
    media: { encrypt_query_param: encryptedParam, aes_key: key.toString('base64'), encrypt_type: 1 },
    midSize: ciphertext.length,
  }
}
