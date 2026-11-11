import { createHash } from 'node:crypto'
import type { BaseMessage, TextMessage, WsFrame } from '@wecom/aibot-node-sdk'

export type WeComTextFrame = WsFrame<BaseMessage>

export interface WeComInboundText {
  media?: readonly InboundMedia[]
  quote?: string
  messageId: string
  userId: string
  text: string
  chatType: 'single' | 'group'
  conversationId: string
  botId: string
}

export interface InboundMedia { kind: 'image' | 'file' | 'video'; url: string; key?: string }

/** Routing fields recovered from a WeCom template-card callback. */
export interface WeComTemplateCardClick {
  taskId: string
  eventKey: string
  userId: string
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`wecom-aibot: text frame is missing ${field}`)
  }
  return value
}

/** Validate the SDK frame fields used for routing one text message. */
export function normalizeTextFrame(frame: WeComTextFrame): WeComInboundText {
  const body: unknown = frame.body
  if (body === undefined || body === null || typeof body !== 'object') {
    throw new Error('wecom-aibot: text frame is missing body')
  }
  const message = body as Partial<TextMessage>
  const messageId = requiredString(message.msgid, 'msgid')
  const botId = requiredString(message.aibotid, 'aibotid')
  const userId = requiredString(message.from?.userid, 'from.userid')
  const fields = objectFields(body) ?? {}
  const media: InboundMedia[] = []
  const texts: string[] = []
  const readPart = (part: Record<string, unknown>): void => {
    const kind = part.msgtype
    if (kind === 'text' || kind === 'voice') {
      const text = stringField(objectFields(part[kind])?.content)
      if (text !== undefined) texts.push(text)
    }
    if (kind === 'image' || kind === 'file' || kind === 'video') {
      const value = objectFields(part[kind]), url = stringField(value?.url), key = stringField(value?.aeskey)
      if (url === undefined) throw new Error('wecom-aibot: media callback has no URL')
      media.push({ kind, url, ...key === undefined ? {} : { key } })
    }
  }
  if (fields.msgtype === 'mixed') {
    const items = objectFields(fields.mixed)?.msg_item
    if (!Array.isArray(items)) throw new Error('wecom-aibot: malformed mixed callback')
    for (const item of items) { const part = objectFields(item); if (part !== undefined) readPart(part) }
  } else readPart(fields)
  // Programmatic text callers predating msgtype remain supported.
  if (fields.msgtype === undefined && message.text?.content) texts.push(message.text.content)
  const text = texts.join('\n') || (media.length ? '[企微附件]' : '')
  requiredString(text, 'message content')
  const quote = objectFields(fields.quote)
  const quoteText = stringField(objectFields(quote?.text)?.content) ?? stringField(objectFields(quote?.voice)?.content)
  if (message.chattype !== 'single' && message.chattype !== 'group') {
    throw new Error('wecom-aibot: text frame has invalid chattype')
  }
  const conversationId = message.chattype === 'group'
    ? requiredString(message.chatid, 'chatid')
    : userId
  return { messageId, userId, text, chatType: message.chattype, conversationId, botId,
    ...media.length ? { media } : {}, ...quoteText === undefined ? {} : { quote: quoteText } }
}

function objectFields(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object'
    ? value as Record<string, unknown>
    : undefined
}

function stringField(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

/** Read the nested button payload used by WeCom template-card callbacks. */
export function normalizeTemplateCardClick(frame: WsFrame<unknown>): WeComTemplateCardClick | undefined {
  const body = objectFields(frame.body)
  const event = objectFields(body?.event)
  const click = objectFields(event?.template_card_event)
  const from = objectFields(body?.from)
  const taskId = stringField(click?.task_id)
  const eventKey = stringField(click?.event_key)
  const userId = stringField(from?.userid)
  return taskId === undefined || eventKey === undefined || userId === undefined
    ? undefined
    : { taskId, eventKey, userId }
}

function digest(parts: readonly string[]): string {
  return createHash('sha256').update(JSON.stringify(parts)).digest('hex')
}

/** Stable non-PII key for the plugin's durable active-Session binding. */
export function conversationKeyFor(message: WeComInboundText): string {
  return digest([message.botId, message.chatType, message.conversationId])
}

/** Derive a stable, non-PII Harness session id for one WeCom conversation. */
export function sessionIdFor(message: WeComInboundText): string {
  return `session-wecom-${conversationKeyFor(message)}`
}

/** Derive the durable Host prompt identity used for restart-safe deduplication. */
export function promptRpcIdFor(message: WeComInboundText): string {
  return `wecom-prompt-${digest([message.botId, message.messageId])}`
}
