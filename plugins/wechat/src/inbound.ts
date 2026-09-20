import { createHash } from 'node:crypto'
import { DEFAULT_CDN_BASE_URL } from './config.js'
import { downloadMedia } from './media.js'
import { MessageItemType } from './protocol.js'
import type { MessageItem, WeixinMessage } from './protocol.js'

export type PromptContentPart =
  | { type: 'text'; text: string }
  | { type: 'image'; mediaType: 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif'; data: string; name?: string }

export interface WeChatInboundMessage {
  accountId: string
  messageId: string
  userId: string
  contextToken?: string
  content: PromptContentPart[]
}

function digest(parts: readonly string[]): string {
  return createHash('sha256').update(JSON.stringify(parts)).digest('hex')
}

function messageIdentity(message: WeixinMessage): string {
  const identity = message.client_id ?? message.message_id?.toString()
  if (identity === undefined) throw new Error('wechat: inbound message has no stable id')
  return identity
}

function imageMediaType(bytes: Buffer): 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif' {
  if (bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return 'image/png'
  if (bytes.subarray(0, 3).equals(Buffer.from([255, 216, 255]))) return 'image/jpeg'
  if (bytes.subarray(0, 4).toString('ascii') === 'GIF8') return 'image/gif'
  if (bytes.subarray(8, 12).toString('ascii') === 'WEBP') return 'image/webp'
  throw new Error('wechat: unsupported inbound image encoding')
}

function textFor(item: MessageItem): string | undefined {
  if (item.type === MessageItemType.TEXT) return item.text_item?.text
  if (item.type === MessageItemType.VOICE) return item.voice_item?.text ?? '[微信语音消息：未提供转写文本]'
  if (item.type === MessageItemType.FILE) return `[微信文件：${item.file_item?.file_name ?? '未命名文件'}]`
  if (item.type === MessageItemType.VIDEO) return '[微信视频消息]'
  return undefined
}

async function contentParts(
  message: WeixinMessage,
  mediaMaxBytes: number,
): Promise<PromptContentPart[]> {
  const content: PromptContentPart[] = []
  for (const item of message.item_list ?? []) {
    const text = textFor(item)
    if (text !== undefined && text !== '') content.push({ type: 'text', text })
    if (item.type !== MessageItemType.IMAGE || item.image_item?.media === undefined) continue
    const key = item.image_item.aeskey === undefined
      ? item.image_item.media.aes_key
      : Buffer.from(item.image_item.aeskey, 'hex').toString('base64')
    const bytes = await downloadMedia(item.image_item.media, key, DEFAULT_CDN_BASE_URL, mediaMaxBytes)
    content.push({ type: 'image', mediaType: imageMediaType(bytes), data: bytes.toString('base64') })
  }
  if (content.length === 0) content.push({ type: 'text', text: '[微信消息没有可读取的内容]' })
  return content
}

/** Normalize one iLink update into the Host prompt representation. */
export async function normalizeInboundMessage(
  accountId: string,
  message: WeixinMessage,
  mediaMaxBytes: number,
): Promise<WeChatInboundMessage> {
  if (message.from_user_id === undefined || message.from_user_id === '') {
    throw new Error('wechat: inbound message has no sender')
  }
  return {
    accountId,
    messageId: messageIdentity(message),
    userId: message.from_user_id,
    ...message.context_token === undefined ? {} : { contextToken: message.context_token },
    content: await contentParts(message, mediaMaxBytes),
  }
}

/** Stable non-PII key for one account and WeChat peer. */
export function conversationKeyFor(message: WeChatInboundMessage): string {
  return digest([message.accountId, message.userId])
}

/** Stable fallback Harness session id for one WeChat conversation. */
export function sessionIdFor(message: WeChatInboundMessage): string {
  return `session-wechat-${conversationKeyFor(message)}`
}

/** Durable Host prompt identity used for restart-safe deduplication. */
export function promptRpcIdFor(message: WeChatInboundMessage): string {
  return `wechat-prompt-${digest([message.accountId, message.messageId])}`
}
