/** Session-log markers and human-prompt selection for a Codex-backed conversation. */
import type { ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import type { Message } from '@deepseek-ai/dsh-llm'
import type { Session } from '@deepseek-ai/dsh-session'

export const PLUGIN = 'codex-controller'
export const THREAD_MARKER = 'codex-thread:'
const NOTICE_LIMIT = 120
const TITLE_PLUGIN = 'dsh-session-title-llm'

export interface TurnContent {
  text: string
  images: readonly ImageAttachmentRef[]
}

/** The newest direct human text. Plugin notices and tool results are not Codex turns. */
export function latestHumanText(messages: readonly Message[]): string {
  const index = latestUserIndex(messages)
  return index === undefined ? '' : textOf(messages[index])
}

/**
 * Human text plus user-invoked skill and plugin-instruction bodies from the same request.
 * Those bodies are DSH pre-step context, not DSH tool calls, so Codex receives them as text.
 */
export function turnText(messages: readonly Message[]): string {
  const index = latestUserIndex(messages)
  if (index === undefined) return ''
  const forwarded = messages.slice(index + 1).filter(isForwardedInstruction).map(textOf).filter(Boolean)
  return [textOf(messages[index]), ...forwarded].filter(Boolean).join('\n\n')
}

/** Human text and durable images from the same request. */
export function turnContent(messages: readonly Message[]): TurnContent {
  const index = latestUserIndex(messages)
  if (index === undefined) return { text: '', images: [] }
  const message = messages[index]
  const images = message.content
    .filter(block => block.type === 'image')
    .map(block => block.attachment)
  return { text: turnText(messages), images }
}

/**
 * The question behind a title request. The title service sends its own plugin message
 * holding the human messages as JSON, so the ordinary human-text selection finds nothing.
 */
export function titleText(messages: readonly Message[]): string {
  const direct = turnText(messages)
  if (direct) return direct
  const framed = messages.find(message => (message.source as { plugin?: string }).plugin === TITLE_PLUGIN)
  return firstFramedText(textOf(framed))
}

/** A short list title taken from the question. Codex identity is not written into the title. */
export function localTitle(text: string): string {
  const topic = text.split('\n').map(line => line.trim()).find(Boolean)?.replace(/^\/[a-z0-9-]+\s*/i, '').replace(/\s+/g, ' ').trim() ?? ''
  const clipped = topic.length > 42 ? topic.slice(0, 41) + '…' : topic
  return '【codex】' + (clipped || '新会话')
}

/** Recover a thread id previously written into this session's notices. */
export function threadIdFromSession(session: Pick<Session, 'snapshotEvents'>): string | undefined {
  const events = session.snapshotEvents()
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]
    if (event?.type !== 'user/message') continue
    const source = event.data.source
    if (source.kind !== 'plugin' || source.plugin !== PLUGIN) continue
    for (const block of event.data.content) {
      if (block.type !== 'text') continue
      const match = new RegExp(THREAD_MARKER + '([A-Za-z0-9_-]+)').exec(block.text)
      if (match?.[1]) return match[1]
    }
  }
  return undefined
}

export function threadNotice(threadId: string): { summary: string; text: string } {
  return { summary: bound('已关联 Codex 会话'), text: THREAD_MARKER + threadId }
}

function firstFramedText(framed: string): string {
  const start = framed.indexOf('[')
  const end = framed.lastIndexOf(']')
  if (start < 0 || end <= start) return ''
  let entries: unknown
  try {
    entries = JSON.parse(framed.slice(start, end + 1))
  } catch {
    return ''
  }
  if (!Array.isArray(entries)) return ''
  for (const entry of entries) {
    const text = entry !== null && typeof entry === 'object' ? (entry as { text?: unknown }).text : undefined
    if (typeof text === 'string' && text.trim()) return text
  }
  return ''
}

function latestUserIndex(messages: readonly Message[]): number | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (message?.role === 'user' && message.source.kind === 'user' && hasPromptContent(message)) return index
  }
}

function hasPromptContent(message: Message): boolean {
  return message.content.some(block => block.type === 'image' || (block.type === 'text' && block.text.trim()))
}

function textOf(message: Message | undefined): string {
  return message?.content.filter(block => block.type === 'text').map(block => block.text).join('\n').trim() ?? ''
}

function isForwardedInstruction(message: Message): boolean {
  const source = message.source as { kind?: string; form?: string; plugin?: string }
  if (message.role !== 'user' || source.form !== 'instructions') return false
  if (source.kind === 'skill-invocation') return true
  return source.kind === 'plugin' && source.plugin !== PLUGIN
}

export function bound(summary: string): string {
  const trimmed = summary.replace(/\s+/g, ' ').trim()
  return trimmed.length <= NOTICE_LIMIT ? trimmed : trimmed.slice(0, NOTICE_LIMIT - 1) + '…'
}
