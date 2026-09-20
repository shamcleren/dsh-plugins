import type { ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import type { HostSessionEvent } from './host-api.js'

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object'
    ? value as Record<string, unknown>
    : undefined
}

function sourceRpcId(message: unknown): string | undefined {
  const source = record(record(message)?.source)
  return typeof source?.rpcId === 'string' ? source.rpcId : undefined
}

/** Return every Host prompt identity admitted by one durable event. */
export function admittedPromptRpcIds(event: HostSessionEvent): string[] {
  if (event.type === 'user/message') {
    const rpcId = sourceRpcId(event.data)
    return rpcId === undefined ? [] : [rpcId]
  }
  if (event.type !== 'agent/inbox/spliced') return []
  const inserted = record(event.data)?.inserted
  if (!Array.isArray(inserted)) return []
  return inserted.flatMap((message) => {
    const rpcId = sourceRpcId(message)
    return rpcId === undefined ? [] : [rpcId]
  })
}

/** Whether a durable event contains the Host admission receipt for a prompt. */
export function eventAdmitsPrompt(event: HostSessionEvent, promptRpcId: string): boolean {
  return admittedPromptRpcIds(event).includes(promptRpcId)
}

/** Extract text from one assembled assistant message event. */
export function assistantText(event: HostSessionEvent): string | undefined {
  if (event.type !== 'assistant/message') return undefined
  const content = record(record(event.data)?.message)?.content
  if (!Array.isArray(content)) return undefined
  const text = content
    .map((block) => {
      const item = record(block)
      return item?.type === 'text' && typeof item.text === 'string' ? item.text : ''
    })
    .join('')
  return text === '' ? undefined : text
}

/** Collect the durable image attachments one assistant message carries. */
export function assistantImages(event: HostSessionEvent): ImageAttachmentRef[] {
  if (event.type !== 'assistant/message') return []
  const content = record(record(event.data)?.message)?.content
  if (!Array.isArray(content)) return []
  return content.flatMap((block) => {
    const item = record(block)
    if (item?.type !== 'image') return []
    const attachment = record(item.attachment)
    return attachment === undefined ? [] : [attachment as unknown as ImageAttachmentRef]
  })
}

/** Extract one text delta and its block index from a raw chunk event. */
export function textDelta(event: HostSessionEvent): { index: number; text: string } | undefined {
  if (event.type !== 'assistant/chunk') return undefined
  const chunk = record(record(event.data)?.chunk)
  if (chunk?.type !== 'text-delta' || typeof chunk.index !== 'number' || typeof chunk.text !== 'string') {
    return undefined
  }
  return { index: chunk.index, text: chunk.text }
}

/** Extract the turn coordinate carried by a turn-scoped event. */
export function eventTurn(event: HostSessionEvent): number | undefined {
  const turn = record(event.data)?.turn
  return typeof turn === 'number' ? turn : undefined
}

/** Convert a durable turn ending into a user-facing fallback when no text exists. */
export function fallbackReply(reason: unknown): string {
  const kind = record(reason)?.kind
  switch (kind) {
    case 'completed':
      return '本轮没有文本回复。'
    case 'blocked':
      return '这个请求当前无法执行。'
    case 'aborted':
    case 'interrupted':
      return '请求已取消。'
    case 'max-tokens':
      return '回复达到长度限制。'
    case 'error':
    default:
      return '处理请求时发生错误，请稍后重试。'
  }
}

export interface TurnProjectionUpdate {
  partial?: string
  outcome?: { text: string; images: readonly ImageAttachmentRef[]; reason: unknown }
}

/** Fold one admitted prompt's durable events into reply updates. */
export class TurnProjection {
  private admitted = false
  private openTurn: number | undefined
  private ownedTurn: number | undefined
  private readonly completedText: string[] = []
  private stepText = new Map<number, string>()
  private readonly images: ImageAttachmentRef[] = []

  constructor(private readonly promptRpcId: string) {}

  push(event: HostSessionEvent): TurnProjectionUpdate {
    if (eventAdmitsPrompt(event, this.promptRpcId)) this.admitted = true
    if (event.type === 'turn/start') {
      this.openTurn = eventTurn(event)
      if (this.admitted && this.ownedTurn === undefined) this.ownedTurn = this.openTurn
    }
    if (event.type === 'user/message' && eventAdmitsPrompt(event, this.promptRpcId)) {
      this.ownedTurn = this.openTurn
    }
    if (this.ownedTurn === undefined || eventTurn(event) !== this.ownedTurn) return {}
    if (event.type === 'step/start') {
      this.commitStep()
      this.stepText = new Map()
    }
    const delta = textDelta(event)
    let partial = delta === undefined ? undefined : this.append(delta.index, delta.text)
    const assembled = assistantText(event)
    if (assembled !== undefined) {
      this.stepText = new Map([[0, assembled]])
      partial = this.fullText()
    }
    this.images.push(...assistantImages(event))
    if (event.type !== 'turn/end') return partial === undefined ? {} : { partial }
    const data = record(event.data) ?? {}
    return {
      ...partial === undefined ? {} : { partial },
      outcome: { text: this.fullText(), images: [...this.images], reason: data.reason },
    }
  }

  private append(index: number, text: string): string {
    this.stepText.set(index, (this.stepText.get(index) ?? '') + text)
    return this.fullText()
  }

  private stepValue(): string {
    return [...this.stepText.entries()]
      .sort(([left], [right]) => left - right)
      .map(([, value]) => value)
      .join('')
  }

  private commitStep(): void {
    const text = this.stepValue()
    if (text !== '') this.completedText.push(text)
  }

  private fullText(): string {
    return [...this.completedText, this.stepValue()].filter(text => text !== '').join('\n\n')
  }
}
