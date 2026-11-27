/** Outbound image, file, and video delivery helpers for WeCom turns. */
import type { Logger } from '@deepseek-ai/cordis'
import type { FileAttachmentRef, ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import type { WsFrame } from '@wecom/aibot-node-sdk'
import { collectFileBytes, type OutboundFileBytes } from './files.js'
import type { TurnOutcome } from './reply.js'

/**
 * Images travel as their own WeCom messages after the text, so a turn that
 * produced only images still needs the text reply suppressed rather than filled
 * with the "no text" fallback.
 */
export const IMAGE_LEAD_IN = '图片如下：'

const IMAGE_EXTENSIONS: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
}

export function undeliveredImageNotice(failed: number, total: number): string {
  const scope = failed === total ? `本轮生成的 ${total} 张图片` : `其中 ${failed} 张图片`
  return `${scope}未能发送到企微，已保存在 DSH 会话中。`
}

/** A display name WeCom accepts, keeping the stored extension meaningful. */
export function imageFilename(ref: ImageAttachmentRef, index: number): string {
  const extension = IMAGE_EXTENSIONS[ref.mediaType] ?? 'png'
  const base = ref.name?.replaceAll(/[/\\]/gu, '').trim()
  if (base === undefined || base === '') return `image-${index + 1}.${extension}`
  return /\.[a-z0-9]+$/iu.test(base) ? base : `${base}.${extension}`
}

export interface WeComMediaDeliveryContext {
  readonly logger: Logger
  readonly mediaMaxBytes: number
  readonly isStopping: () => boolean
  readonly signal: () => AbortSignal
  readonly readImage?: (ref: ImageAttachmentRef) => Promise<Uint8Array>
  readonly readFile?: (ref: FileAttachmentRef, signal: AbortSignal) => AsyncIterable<Uint8Array>
  readonly readPresentedFile?: (sessionId: string, path: string, maxBytes: number, signal: AbortSignal) => Promise<OutboundFileBytes>
  readonly uploadMedia: (
    fileBuffer: Buffer,
    options: { type: 'image' | 'file' | 'video'; filename: string },
  ) => Promise<{ media_id: string }>
  readonly sendMediaMessage: (targetId: string, mediaType: 'image' | 'file' | 'video', mediaId: string) => Promise<WsFrame>
  readonly sendNotice: (targetId: string, text: string) => Promise<WsFrame>
}

/**
 * Deliver durable images as their own WeCom messages. Each one is uploaded as
 * temporary media and pushed through the active-send channel, which stays
 * usable after the stream reply has already finished. Anything that cannot be
 * delivered is named in a single notice instead of disappearing.
 */
export async function sendWeComImages(
  ctx: WeComMediaDeliveryContext,
  targetId: string,
  images: readonly ImageAttachmentRef[],
): Promise<void> {
  if (images.length === 0) return
  let failed = 0
  for (const [index, ref] of images.entries()) {
    if (ctx.isStopping()) return
    try {
      if (ctx.readImage === undefined) throw new Error('this deployment has no attachment store')
      const data = await ctx.readImage(ref)
      const media = await ctx.uploadMedia(Buffer.from(data), {
        type: 'image',
        filename: imageFilename(ref, index),
      })
      await ctx.sendMediaMessage(targetId, 'image', media.media_id)
    } catch (error: unknown) {
      failed += 1
      ctx.logger.error(error)
    }
  }
  if (failed === 0 || ctx.isStopping()) return
  await ctx.sendNotice(targetId, undeliveredImageNotice(failed, images.length))
    .catch((error: unknown) => { ctx.logger.error(error) })
}

export async function sendWeComFiles(
  ctx: WeComMediaDeliveryContext,
  sessionId: string,
  targetId: string,
  files: TurnOutcome['files'],
): Promise<void> {
  let failed = 0
  const signal = ctx.signal()
  for (const file of files) {
    if (ctx.isStopping()) return
    try {
      let loaded: OutboundFileBytes
      if (file.kind === 'presented') {
        if (ctx.readPresentedFile === undefined) throw new Error('presented file reader unavailable')
        loaded = await ctx.readPresentedFile(sessionId, file.path, ctx.mediaMaxBytes, signal)
      } else {
        if (file.attachment.bytes > ctx.mediaMaxBytes) throw new Error('file exceeds mediaMaxBytes')
        if (ctx.readFile === undefined) throw new Error('file attachment store unavailable')
        const bytes = await collectFileBytes(ctx.readFile(file.attachment, signal), ctx.mediaMaxBytes, signal)
        if (bytes.length !== file.attachment.bytes) throw new Error('file attachment length mismatch')
        loaded = { name: file.attachment.name, bytes }
      }
      signal.throwIfAborted()
      if (loaded.bytes.length > ctx.mediaMaxBytes) throw new Error('file exceeds mediaMaxBytes')
      const name = loaded.name.split(/[\\/]/u).at(-1) || 'attachment'
      const type = /\.(mp4|m4v|mov)$/iu.test(name) ? 'video' : 'file'
      const media = await ctx.uploadMedia(loaded.bytes, { type, filename: name })
      signal.throwIfAborted()
      await ctx.sendMediaMessage(targetId, type, media.media_id)
    } catch {
      failed += 1
      // Signed CDN parameters and local paths must not enter channel logs.
      ctx.logger.warn('wecom-aibot: file/video delivery failed')
    }
  }
  if (failed === 0 || ctx.isStopping()) return
  await ctx.sendNotice(
    targetId,
    `本轮 ${files.length} 个文件或视频中的 ${failed} 个未能发送到企微，请在 DSH 会话中查看；可能超过媒体大小限制或上传失败。`,
  )
}
