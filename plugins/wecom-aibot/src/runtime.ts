import type { Logger } from '@deepseek-ai/cordis'
import type { Config, WeComCredentials, WeComSettingsPatch } from './config.js'
import { resolveRuntimeConfig } from './config.js'
import { WeComBotAccount } from './account.js'
import type { WeComBotClient } from './account.js'
import type { HostApiProxy } from './host-api.js'
import { WeComConversationRouter } from './router.js'
import type { WeComReplyClient } from './router.js'
import type { ChannelApprovalAnswer, ChannelApprovalRequest, RouterRuntimeContext } from './router.js'
import { IdleSleepAssertion } from './wake.js'

type RuntimeClient = WeComBotClient & WeComReplyClient

interface ActiveConnection {
  key: string
  account: WeComBotAccount
  router: WeComConversationRouter
  wake: IdleSleepAssertion | undefined
}

export interface WeComRuntimeOptions {
  api: HostApiProxy
  logger: Logger
  resolveCredentials(config: Config): Promise<WeComCredentials | undefined>
  createClient(credentials: WeComCredentials): RuntimeClient
  prepareContext(config: Config): Promise<RouterRuntimeContext>
  /** Persist a channel policy change made from a chat command. */
  writeSettings(section: WeComSettingsPatch): Promise<void>
}

/** Keep the Bot connection synchronized with live settings and credentials. */
export class WeComRuntimeController {
  private desired: Config = {}
  private generation = 0
  private stopped = false
  private active: ActiveConnection | undefined
  private tail: Promise<void> = Promise.resolve()
  /** Keeps one unconfigured streak from repeating the same warning on every reconcile. */
  private warnedUnconfigured = false

  constructor(private readonly options: WeComRuntimeOptions) {}

  update(config: Config): void {
    if (this.stopped) return
    this.desired = config
    const generation = ++this.generation
    this.tail = this.tail.then(() => this.reconcile(generation)).catch((error: unknown) => {
      this.options.logger.error(error)
    })
  }

  /** Whether the live channel router owns this exact session turn. */
  routesSession(sessionId: string): boolean {
    return this.active?.router.routesSession(sessionId) === true
  }

  observesSession(sessionId: string): boolean {
    return this.active?.router.observesSession(sessionId) === true
  }

  ownsSession(sessionId: string): boolean {
    return this.active?.router.ownsSession(sessionId) === true
  }

  /** Present an approval through the live channel router. */
  async requestApproval(request: ChannelApprovalRequest): Promise<ChannelApprovalAnswer | undefined> {
    return await this.active?.router.requestApproval(request)
  }

  async stop(): Promise<void> {
    if (this.stopped) return
    this.stopped = true
    this.generation += 1
    await this.tail
    await this.stopActive()
  }

  private async reconcile(generation: number): Promise<void> {
    const config = this.desired
    const credentials = await this.options.resolveCredentials(config)
    if (this.stopped || generation !== this.generation) return
    if (credentials === undefined) {
      await this.stopActive()
      if (!this.warnedUnconfigured) {
        this.warnedUnconfigured = true
        this.options.logger.warn('wecom-aibot: Bot ID or secret is not configured; the Bot stays offline')
      }
      return
    }
    this.warnedUnconfigured = false
    // The preset is deliberately outside the key: `/preset` persists through the
    // settings service, which reconciles us back synchronously, and tearing the
    // socket down there would drop the command's own reply mid-flight.
    const { agentPreset, ...connectionPolicy } = resolveRuntimeConfig(config)
    const key = JSON.stringify([
      credentials,
      connectionPolicy,
      config.workspaceId,
      config.workspaceName,
    ])
    if (this.active?.key === key) {
      this.active.router.setAgentPreset(agentPreset)
      return
    }
    await this.stopActive()
    if (this.stopped || generation !== this.generation) return
    await this.startActive(key, credentials, config)
  }

  private async startActive(key: string, credentials: WeComCredentials, config: Config): Promise<void> {
    const context = await this.options.prepareContext(config)
    const client = this.options.createClient(credentials)
    const router = new WeComConversationRouter(
      this.options.api,
      client,
      this.options.logger,
      resolveRuntimeConfig(config),
      context,
      section => this.options.writeSettings(section),
    )
    const account = new WeComBotAccount(
      client,
      this.options.logger,
      frame => { router.accept(frame) },
      frame => { router.acceptTemplateCardEvent(frame) },
    )
    const wake = await IdleSleepAssertion.start(config.preventIdleSleep === true)
    router.start()
    try {
      account.start()
    } catch (error) {
      await router.stop()
      await wake?.stop()
      throw error
    }
    this.active = { key, account, router, wake }
  }

  private async stopActive(): Promise<void> {
    const active = this.active
    if (active === undefined) return
    this.active = undefined
    active.account.stop()
    await active.router.stop()
    await active.wake?.stop()
  }
}
