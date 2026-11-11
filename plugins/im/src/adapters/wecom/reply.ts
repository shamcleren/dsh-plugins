import type { FileAttachmentRef, ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import type { HostSessionEvent } from './host-api.js'

/** WeCom's documented UTF-8 limit for a stream reply body. */
export const MAX_STREAM_REPLY_BYTES = 20_480

/** Cut text at a valid code-point boundary within WeCom's byte limit. */
export function boundReply(text: string, maxBytes = MAX_STREAM_REPLY_BYTES): string {
  let bytes = 0
  let result = ''
  for (const character of text) {
    const next = Buffer.byteLength(character)
    if (bytes + next > maxBytes) break
    result += character
    bytes += next
  }
  return result
}

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

/** Durable image references carried by one assembled assistant message. */
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

/** Recover a shell command from the exact durable tool call named by an approval. */
export function approvalCommand(event: HostSessionEvent, callId: string): string | undefined {
  if (event.type !== 'tool/call') return undefined
  const data = record(event.data)
  if (data?.callId !== callId || typeof data.arguments !== 'string') return undefined
  let args: unknown
  try {
    args = JSON.parse(data.arguments)
  } catch (error: unknown) {
    if (!(error instanceof SyntaxError)) throw error
    return undefined
  }
  const fields = record(args)
  return typeof fields?.command === 'string' ? fields.command : undefined
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

export type OutboundFile = { kind: 'attachment'; attachment: FileAttachmentRef } | { kind: 'presented'; path: string }

/** Only explicit delivered files are sent; prose links never trigger filesystem reads. */
export function deliveredFiles(event: HostSessionEvent): OutboundFile[] {
  if (event.type === 'deliverables/presented') {
    const data = record(event.data)
    if (typeof data?.callId !== 'string' || !Array.isArray(data.files)) return []
    return data.files.flatMap(value => {
      const file = record(value)
      return typeof file?.path === 'string' && file.path.trim() !== ''
        ? [{ kind: 'presented' as const, path: file.path }] : []
    })
  }
  if (event.type !== 'assistant/message') return []
  const content = record(record(event.data)?.message)?.content
  if (!Array.isArray(content)) return []
  return content.flatMap(value => {
    const block = record(value), attachment = record(block?.attachment)
    if (block?.type !== 'file' || typeof attachment?.attachmentId !== 'string'
      || typeof attachment.name !== 'string' || typeof attachment.bytes !== 'number'
      || !Number.isSafeInteger(attachment.bytes) || attachment.bytes < 0) return []
    return [{ kind: 'attachment' as const, attachment: attachment as unknown as FileAttachmentRef }]
  })
}

export interface TurnOutcome {
  text: string
  images: readonly ImageAttachmentRef[]
  files: readonly OutboundFile[]
  reason: unknown
}

export interface TurnProjectionUpdate {
  partial?: string
  outcome?: TurnOutcome
}

/** Fold one admitted prompt's durable events into reply updates. */
export class TurnProjection {
  private admitted = false
  private openTurn: number | undefined
  private ownedTurn: number | undefined
  private readonly completedText: string[] = []
  private stepText = new Map<number, string>()
  private readonly images: ImageAttachmentRef[] = []
  private readonly files = new Map<string, OutboundFile>()

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
    for (const file of deliveredFiles(event)) {
      const key = file.kind === 'presented' ? `path:${file.path}` : `attachment:${file.attachment.attachmentId}:${file.attachment.name}`
      this.files.set(key, file)
    }
    if (event.type !== 'turn/end') return partial === undefined ? {} : { partial }
    const data = record(event.data) ?? {}
    return {
      ...partial === undefined ? {} : { partial },
      outcome: { text: this.fullText(), images: [...this.images], files: [...this.files.values()], reason: data.reason },
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
