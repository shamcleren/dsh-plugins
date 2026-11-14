import { WeChatSendError } from './api.js'

export type MediaStage = 'read' | 'upload' | 'send'

/** Carry only allowlisted diagnostics: never retain file paths, tokens or CDN URLs. */
export class MediaDeliveryError extends Error {
  constructor(readonly stage: MediaStage, readonly category: string) {
    super(`wechat: media delivery failed stage=${stage} category=${category}`)
  }
}

export function mediaFailure(stage: MediaStage, error: unknown): MediaDeliveryError {
  if (error instanceof MediaDeliveryError) return error
  const category = error instanceof WeChatSendError ? error.kind
    : error instanceof Error && error.name === 'AbortError' ? 'aborted'
    : error instanceof Error && error.name === 'TimeoutError' ? 'timeout'
    : 'unknown'
  return new MediaDeliveryError(stage, category)
}

/** Sniff common raster formats rather than trusting a potentially misleading extension. */
export function isImageBytes(bytes: Buffer): boolean {
  return (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff)
    || (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex')))
    || (bytes.length >= 6 && /^(GIF87a|GIF89a)$/u.test(bytes.subarray(0, 6).toString('ascii')))
    || (bytes.length >= 12 && bytes.subarray(0, 4).toString('ascii') === 'RIFF'
      && bytes.subarray(8, 12).toString('ascii') === 'WEBP')
}
