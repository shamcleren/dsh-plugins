import type { Logger } from '@deepseek-ai/cordis'
import type {
  EventMessageWith,
  TemplateCardEventData,
  TextMessage,
  WsFrame,
} from '@wecom/aibot-node-sdk'

type ConnectionListener = () => void
type DisconnectionListener = (reason: string) => void
type ErrorListener = (error: Error) => void
type TextMessageListener = (frame: WsFrame<TextMessage>) => void
type TemplateCardEventListener = (frame: WsFrame<EventMessageWith<TemplateCardEventData>>) => void

/** SDK operations used by the connection lifecycle. */
export interface WeComBotClient {
  connect(): unknown
  disconnect(): void
  on(event: 'authenticated', listener: ConnectionListener): unknown
  on(event: 'disconnected', listener: DisconnectionListener): unknown
  on(event: 'error', listener: ErrorListener): unknown
  on(event: 'message.text', listener: TextMessageListener): unknown
  on(event: 'event.template_card_event', listener: TemplateCardEventListener): unknown
  off(event: 'authenticated', listener: ConnectionListener): unknown
  off(event: 'disconnected', listener: DisconnectionListener): unknown
  off(event: 'error', listener: ErrorListener): unknown
  off(event: 'message.text', listener: TextMessageListener): unknown
  off(event: 'event.template_card_event', listener: TemplateCardEventListener): unknown
}

/** Own one WeCom SDK connection and every listener attached to it. */
export class WeComBotAccount {
  private started = false

  private readonly authenticated = (): void => {
    this.logger.info('WeCom Bot authenticated')
  }

  private readonly disconnected = (reason: string): void => {
    this.logger.warn('WeCom Bot disconnected: %s', reason)
  }

  private readonly failed = (error: Error): void => {
    this.logger.error(error)
  }

  private readonly textMessage = (frame: WsFrame<TextMessage>): void => {
    this.onTextMessage(frame)
  }

  private readonly templateCardEvent = (
    frame: WsFrame<EventMessageWith<TemplateCardEventData>>,
  ): void => {
    this.onTemplateCardEvent(frame)
  }

  constructor(
    private readonly client: WeComBotClient,
    private readonly logger: Logger,
    private readonly onTextMessage: TextMessageListener,
    private readonly onTemplateCardEvent: TemplateCardEventListener,
  ) {}

  /** Attach diagnostics and begin the SDK-owned connection lifecycle. */
  start(): void {
    if (this.started) return
    this.attachListeners()
    try {
      this.client.connect()
      this.started = true
    } catch (error) {
      this.detachListeners()
      throw error
    }
  }

  /** Disconnect and remove every listener owned by this account. */
  stop(): void {
    if (!this.started) return
    this.started = false
    this.detachListeners()
    this.client.disconnect()
  }

  private attachListeners(): void {
    this.client.on('authenticated', this.authenticated)
    this.client.on('disconnected', this.disconnected)
    this.client.on('error', this.failed)
    this.client.on('message.text', this.textMessage)
    this.client.on('event.template_card_event', this.templateCardEvent)
  }

  private detachListeners(): void {
    this.client.off('authenticated', this.authenticated)
    this.client.off('disconnected', this.disconnected)
    this.client.off('error', this.failed)
    this.client.off('message.text', this.textMessage)
    this.client.off('event.template_card_event', this.templateCardEvent)
  }
}
