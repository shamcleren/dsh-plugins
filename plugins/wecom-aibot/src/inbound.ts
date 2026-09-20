import { createHash } from 'node:crypto'
import type { TextMessage, WsFrame } from '@wecom/aibot-node-sdk'

export type WeComTextFrame = WsFrame<TextMessage>

export interface WeComInboundText {
  messageId: string
  userId: string
  text: string
  chatType: 'single' | 'group'
  conversationId: string
  botId: string
}

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
  const text = requiredString(message.text?.content, 'text.content')
  if (message.chattype !== 'single' && message.chattype !== 'group') {
    throw new Error('wecom-aibot: text frame has invalid chattype')
  }
  const conversationId = message.chattype === 'group'
    ? requiredString(message.chatid, 'chatid')
    : userId
  return { messageId, userId, text, chatType: message.chattype, conversationId, botId }
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
