import type { Logger } from '@deepseek-ai/cordis'
import { getUpdates, notifyLifecycle, sendMessage, sendTyping } from './api.js'
import { DEFAULT_CDN_BASE_URL } from './config.js'
import { normalizeInboundMessage } from './inbound.js'
import type { WeChatInboundMessage } from './inbound.js'
import { uploadImage, uploadMedia } from './media.js'
import type { MessageItem, WeChatAccountCredentials } from './protocol.js'
import { MessageItemType, UploadMediaType } from './protocol.js'
import { inboundFailure } from '../../core/commands.js'
import type { WeChatAccountStore } from './storage.js'
import type { WeChatDelivery } from './delivery.js'

const DEFAULT_POLL_TIMEOUT_MS = 35_000
const FAILURE_BACKOFF_MS = 30_000
const RETRY_DELAY_MS = 2_000

function delay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise(resolve => {
    const timer = setTimeout(resolve, ms)
    signal.addEventListener('abort', () => {
      clearTimeout(timer)
      resolve()
    }, { once: true })
  })
}

function textChunks(text: string, limit = 4_000): string[] {
  const chunks: string[] = []
  let current = ''
  for (const character of text) {
    if (current.length + character.length > limit) {
      chunks.push(current)
      current = ''
    }
    current += character
  }
  if (current !== '') chunks.push(current)
  return chunks
}

/** Long-lived iLink account transport and outbound reply operations. */
export class WeChatAccount {
  private readonly abort = new AbortController()
  private readonly messageFailures = new Map<string, number>()
  private task: Promise<void> | undefined

  constructor(
    readonly credentials: WeChatAccountCredentials,
    private readonly store: WeChatAccountStore,
    private readonly logger: Logger,
    private readonly mediaMaxBytes: number,
    private readonly onMessage: (message: WeChatInboundMessage) => Promise<void>,
    private readonly delivery?: WeChatDelivery,
    private readonly reportFailure?: (kind: 'message-format' | 'media' | 'host') => void,
  ) {}

  start(): void {
    if (this.task !== undefined) return
    this.task = this.monitor()
    void this.task.catch((error: unknown) => { this.logger.error(error) })
  }

  async stop(): Promise<void> {
    this.abort.abort()
    await this.task
    await notifyLifecycle(this.credentials, 'stop').catch((error: unknown) => {
      this.logger.warn(`wechat: notify stop failed for ${this.credentials.accountId}: ${String(error)}`)
    })
  }

  async sendText(userId: string, text: string, contextToken?: string): Promise<void> {
    const replyToken = contextToken ?? this.store.contextToken(this.credentials.accountId, userId)
    for (const chunk of textChunks(text)) {
      await this.send(userId, { type: 1, text_item: { text: chunk } }, replyToken)
    }
  }

  async sendImage(userId: string, bytes: Buffer, contextToken?: string): Promise<void> {
    const replyToken = contextToken ?? this.store.contextToken(this.credentials.accountId, userId)
    const uploaded = await uploadImage({
      ...this.credentials,
      userId,
      bytes,
      cdnBaseUrl: DEFAULT_CDN_BASE_URL,
    })
    await this.send(userId, {
        type: MessageItemType.IMAGE,
        image_item: { media: uploaded.media, mid_size: uploaded.midSize },
    }, replyToken)
  }

  async sendFile(userId: string, bytes: Buffer, name: string, contextToken?: string): Promise<void> {
    await this.sendBinary(userId, bytes, name, contextToken)
  }

  async sendVideo(userId: string, bytes: Buffer, contextToken?: string): Promise<void> {
    await this.sendBinary(userId, bytes, undefined, contextToken)
  }

  private async sendBinary(userId: string, bytes: Buffer, name: string | undefined, contextToken?: string): Promise<void> {
    if (bytes.length > this.mediaMaxBytes) throw new Error('wechat: outbound file exceeds mediaMaxBytes')
    const signal = this.abort.signal
    signal.throwIfAborted()
    const uploaded = await uploadMedia({
      ...this.credentials, userId, bytes, cdnBaseUrl: DEFAULT_CDN_BASE_URL, signal,
      mediaType: name === undefined ? UploadMediaType.VIDEO : UploadMediaType.FILE,
    })
    const replyToken = contextToken ?? this.store.contextToken(this.credentials.accountId, userId)
    await this.send(userId, name === undefined
        ? { type: MessageItemType.VIDEO, video_item: { media: uploaded.media, video_size: uploaded.ciphertextSize } }
        : { type: MessageItemType.FILE, file_item: { media: uploaded.media, file_name: name, len: String(bytes.length) } }, replyToken)
  }

  private async send(userId: string, item: MessageItem, contextToken?: string): Promise<void> {
    if (this.delivery) return this.delivery.send(this.credentials, userId, item, contextToken, this.abort.signal)
    await sendMessage({ ...this.credentials, userId, item, signal: this.abort.signal,
      ...contextToken === undefined ? {} : { contextToken } })
  }

  async typing(userId: string, status: 1 | 2, contextToken?: string): Promise<void> {
    const replyToken = contextToken ?? this.store.contextToken(this.credentials.accountId, userId)
    await sendTyping({
      ...this.credentials,
      userId,
      ...replyToken === undefined ? {} : { contextToken: replyToken },
      status,
    })
  }

  private async monitor(): Promise<void> {
    await notifyLifecycle(this.credentials, 'start').catch((error: unknown) => {
      this.logger.warn(`wechat: notify start failed for ${this.credentials.accountId}: ${String(error)}`)
    })
    let cursor = this.store.cursor(this.credentials.accountId)
    let timeoutMs = DEFAULT_POLL_TIMEOUT_MS
    let failures = 0
    while (!this.abort.signal.aborted) {
      try {
        const update = await getUpdates({ ...this.credentials, cursor, timeoutMs, signal: this.abort.signal })
        if (this.abort.signal.aborted) break
        if ((update.ret ?? 0) !== 0 || (update.errcode ?? 0) !== 0) {
          throw new Error(`wechat: getupdates ret=${update.ret ?? 0} errcode=${update.errcode ?? 0}: ${update.errmsg ?? ''}`)
        }
        failures = 0
        if (update.longpolling_timeout_ms !== undefined && update.longpolling_timeout_ms > 0) {
          timeoutMs = update.longpolling_timeout_ms
        }
        for (const raw of update.msgs ?? []) {
          const failureKey = raw.client_id?.trim() ? raw.client_id : raw.message_id?.toString() ?? JSON.stringify(raw)
          let phase: 'decode' | 'route' = 'decode'
          try {
            const message = await normalizeInboundMessage(this.credentials.accountId, raw, this.mediaMaxBytes, this.abort.signal)
            phase = 'route'
            if (message.contextToken !== undefined) {
              await this.store.saveContextToken(message.accountId, message.userId, message.contextToken)
            }
            await this.delivery?.observe(this.credentials, message.userId, message.messageId)
            await this.onMessage(message)
            this.messageFailures.delete(failureKey)
          } catch (error) {
            this.reportFailure?.(phase === 'route' ? 'host' : raw.item_list?.some(item => item.type === MessageItemType.FILE || item.type === MessageItemType.IMAGE || item.type === MessageItemType.VIDEO) ? 'media' : 'message-format')
            const failures = (this.messageFailures.get(failureKey) ?? 0) + 1
            this.messageFailures.set(failureKey, failures)
            if (failures < 3) throw error
            this.messageFailures.delete(failureKey)
            this.logger.warn('wechat: skipped callback after 3 failed admissions')
            if (typeof raw.from_user_id === 'string' && raw.from_user_id !== '') {
              await this.sendText(raw.from_user_id,
                inboundFailure(phase, raw.item_list?.some(item => (item.type === MessageItemType.FILE || item.type === MessageItemType.IMAGE || item.type === MessageItemType.VIDEO)) === true), raw.context_token)
                .catch(() => { this.logger.warn('wechat: failed to send admission failure notice') })
            }
          }
        }
        if (update.get_updates_buf !== undefined && update.get_updates_buf !== cursor) {
          cursor = update.get_updates_buf
          await this.store.saveCursor(this.credentials.accountId, cursor)
        }
      } catch (error) {
        if (this.abort.signal.aborted) break
        failures += 1
        this.logger.error(error)
        await delay(failures >= 3 ? FAILURE_BACKOFF_MS : RETRY_DELAY_MS, this.abort.signal)
        if (failures >= 3) failures = 0
      }
    }
  }
}
