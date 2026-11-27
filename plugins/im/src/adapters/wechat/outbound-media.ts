/** Outbound reply formatting and image/file/video delivery helpers for WeChat turns. */
import type { Logger } from '@deepseek-ai/cordis'
import type { FileAttachmentRef, ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import { collectFileBytes, type OutboundFileBytes } from './files.js'
import { formatWeChatReply } from './format.js'
import { isImageBytes, mediaFailure, type MediaStage } from './media-delivery.js'
import { fallbackReply, type TurnOutcome } from './reply.js'

/** Announce images that follow as their own messages, so no reply arrives empty. */
export const IMAGE_LEAD_IN = '图片如下：'

export function undeliveredImageNotice(failed: number, total: number): string {
  const scope = failed === total ? `本轮生成的 ${failed} 张图片` : `本轮 ${total} 张图片中的 ${failed} 张`
  return `${scope}未能发送到微信，已保存在 DSH 会话中。`
}

export function finalWeChatReply(completed: TurnOutcome): string {
  if (completed.text.trim() !== '') return formatWeChatReply(completed.text)
  if (completed.files.length > 0) return '附件如下：'
  return completed.images.length > 0 ? IMAGE_LEAD_IN : fallbackReply(completed.reason)
}

export interface WeChatMediaDeliveryContext {
  readonly logger: Logger
  readonly mediaMaxBytes: number
  readonly isStopping: () => boolean
  readonly signal: () => AbortSignal
  readonly readImage?: (ref: ImageAttachmentRef) => Promise<Uint8Array>
  readonly readFile?: (ref: FileAttachmentRef, signal: AbortSignal) => AsyncIterable<Uint8Array>
  readonly readPresentedFile?: (sessionId: string, path: string, maxBytes: number, signal: AbortSignal) => Promise<OutboundFileBytes>
  readonly sendText: (userId: string, text: string, contextToken?: string) => Promise<void>
  readonly sendImage: (userId: string, bytes: Buffer, contextToken?: string) => Promise<void>
  readonly sendFile: (userId: string, bytes: Buffer, name: string, contextToken?: string) => Promise<void>
  readonly sendVideo: (userId: string, bytes: Buffer, contextToken?: string) => Promise<void>
}

/**
 * Upload each image and send it as its own iLink message. A failure names the
 * images that stayed behind rather than dropping them silently.
 */
export async function sendWeChatImages(
  ctx: WeChatMediaDeliveryContext,
  target: { userId: string; contextToken?: string },
  images: readonly ImageAttachmentRef[],
): Promise<void> {
  if (images.length === 0) return
  let failed = 0
  for (const ref of images) {
    if (ctx.isStopping()) return
    let stage: MediaStage = 'read'
    try {
      if (ctx.readImage === undefined) throw new Error('this deployment has no attachment store')
      const data = await ctx.readImage(ref)
      stage = 'send'
      await ctx.sendImage(target.userId, Buffer.from(data), target.contextToken)
    } catch (error: unknown) {
      failed += 1
      ctx.logger.warn(mediaFailure(stage, error).message)
    }
  }
  if (failed === 0 || ctx.isStopping()) return
  await ctx.sendText(
    target.userId, undeliveredImageNotice(failed, images.length), target.contextToken,
  ).catch((error: unknown) => { ctx.logger.error(error) })
}

export async function sendWeChatFiles(
  ctx: WeChatMediaDeliveryContext,
  target: { sessionId: string; userId: string; contextToken?: string },
  files: TurnOutcome['files'],
): Promise<void> {
  let failed = 0
  const signal = ctx.signal()
  for (const file of files) {
    if (ctx.isStopping()) return
    let stage: MediaStage = 'read'
    try {
      let loaded: OutboundFileBytes
      if (file.kind === 'presented') {
        if (ctx.readPresentedFile === undefined) throw new Error('presented file reader unavailable')
        loaded = await ctx.readPresentedFile(target.sessionId, file.path, ctx.mediaMaxBytes, signal)
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
      stage = 'send'
      if (isImageBytes(loaded.bytes)) {
        await ctx.sendImage(target.userId, loaded.bytes, target.contextToken)
      } else if (/\.(mp4|m4v|mov)$/iu.test(name)) {
        await ctx.sendVideo(target.userId, loaded.bytes, target.contextToken)
      } else {
        await ctx.sendFile(target.userId, loaded.bytes, name, target.contextToken)
      }
    } catch (error: unknown) {
      failed += 1
      ctx.logger.warn(mediaFailure(stage, error).message)
    }
  }
  if (failed === 0 || ctx.isStopping()) return
  await ctx.sendText(
    target.userId,
    `本轮 ${files.length} 个附件中的 ${failed} 个未能发送到微信，请在 DSH 会话中查看；可能超过媒体大小限制或上传失败。`,
    target.contextToken,
  )
}
