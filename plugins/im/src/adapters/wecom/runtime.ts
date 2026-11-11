import type { Logger } from '@deepseek-ai/cordis'
import type { Config, WeComCredentials, WeComSettingsPatch } from './config.js'
import { configuredBots, resolveRuntimeConfig } from './config.js'
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
  prepareContext(config: Config & { id?: string }): Promise<RouterRuntimeContext>
  /** Persist a channel policy change made from a chat command. */
  writeSettings(section: WeComSettingsPatch, botId?: string): Promise<void>
}

/** Keep the Bot connection synchronized with live settings and credentials. */
class SingleBotRuntimeController {
  private failed = false
  private desired: Config = {}
  private generation = 0
  private stopped = false
  private active: ActiveConnection | undefined
  private tail: Promise<void> = Promise.resolve()
  /** Keeps one unconfigured streak from repeating the same warning on every reconcile. */
  private warnedUnconfigured = false

  constructor(private readonly options: WeComRuntimeOptions) {}

  state(): 'waiting' | 'starting' | 'running' | 'failed' { return this.active?.account.state() ?? (this.failed ? 'failed' : 'waiting') }

  async ready(): Promise<void> { await this.tail }

  update(config: Config): void {
    if (this.stopped) return
    this.failed = false
    this.desired = config
    const generation = ++this.generation
    this.tail = this.tail.then(() => this.reconcile(generation)).catch((error: unknown) => {
      this.failed = true
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
      config.preventIdleSleep,
    ])
    if (this.active?.key === key) {
      this.active.router.setAgentPreset(agentPreset)
      return
    }
    await this.stopActive()
    if (this.stopped || generation !== this.generation) return
    await this.startActive(key, credentials, config, generation)
  }

  private async startActive(key: string, credentials: WeComCredentials, config: Config, generation: number): Promise<void> {
    const context = await this.options.prepareContext(config)
    if (this.stopped || generation !== this.generation) return
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
    if (this.stopped || generation !== this.generation) { await wake?.stop(); return }
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

/** Reconcile independent connections; a missing credential only takes its own Bot offline. */
export class WeComRuntimeController {
  private readonly bots = new Map<string, SingleBotRuntimeController>()
  private readonly credentials = new Map<string, WeComCredentials | undefined>()
  private tail: Promise<void> = Promise.resolve()
  private stopped = false
  constructor(private readonly options: WeComRuntimeOptions) {}

  state(): { status: 'waiting' | 'starting' | 'running' | 'failed'; accounts: number } {
    const states = [...this.bots.values()].map(bot => bot.state())
    const status = states.includes('failed') ? 'failed' : states.includes('running') ? 'running' : states.includes('starting') ? 'starting' : 'waiting'
    return { status, accounts: states.filter(state => state === 'running').length }
  }

  async ready(): Promise<void> {
    await this.tail
    await Promise.all([...this.bots.values()].map(bot => bot.ready()))
  }

  update(config: Config): void {
    if (this.stopped) return
    // Validate the complete roster before retiring any current connection.
    let roster: ReturnType<typeof configuredBots>
    try { roster = config.connectionEnabled === false ? [] : configuredBots(config) }
    catch (error) { this.options.logger.error(error); return }
    const legacy = config.bots === undefined
    this.tail = this.tail.then(async () => {
      if (this.stopped) return
      const keyFor = (id: string) => `${legacy ? 'legacy' : 'bot'}:${id}`
      const ids = new Set(roster.map(bot => keyFor(bot.id)))
      const resolved = await Promise.allSettled(roster.map(entry => this.options.resolveCredentials(entry)))
      if (this.stopped) return
      const counts = new Map<string, number>()
      for (const result of resolved) if (result.status === 'fulfilled' && result.value !== undefined) {
        counts.set(result.value.botId, (counts.get(result.value.botId) ?? 0) + 1)
      }
      for (const [index, entry] of roster.entries()) {
        const result = resolved[index]
        const credentials = result?.status === 'fulfilled' ? result.value : undefined
        const duplicate = credentials !== undefined && (counts.get(credentials.botId) ?? 0) > 1
        if (duplicate) this.options.logger.error('wecom-aibot: the same Bot account cannot be connected twice')
        else if (result?.status === 'rejected') this.options.logger.error('wecom-aibot: credential resolution failed')
        this.credentials.set(keyFor(entry.id), duplicate ? undefined : credentials)
      }
      for (const [id, bot] of this.bots) if (!ids.has(id)) {
        this.bots.delete(id)
        this.credentials.delete(id)
        await bot.stop()
      }
      for (const entry of roster) {
        let bot = this.bots.get(keyFor(entry.id))
        if (bot === undefined) {
          bot = new SingleBotRuntimeController({ ...this.options,
            resolveCredentials: async () => this.credentials.get(keyFor(entry.id)),
            writeSettings: section => this.options.writeSettings(section, legacy ? undefined : entry.id),
          })
          this.bots.set(keyFor(entry.id), bot)
        }
        bot.update(entry)
      }
    }).catch((error: unknown) => { this.options.logger.error(error) })
  }
  routesSession(id: string): boolean { return [...this.bots.values()].some(bot => bot.routesSession(id)) }
  observesSession(id: string): boolean { return [...this.bots.values()].some(bot => bot.observesSession(id)) }
  ownsSession(id: string): boolean { return [...this.bots.values()].some(bot => bot.ownsSession(id)) }
  async requestApproval(request: ChannelApprovalRequest): Promise<ChannelApprovalAnswer | undefined> {
    for (const bot of this.bots.values()) {
      const answer = await bot.requestApproval(request)
      if (answer !== undefined) return answer
    }
    return undefined
  }
  async stop(): Promise<void> {
    if (this.stopped) return
    this.stopped = true
    await this.tail
    await Promise.all([...this.bots.values()].map(bot => bot.stop()))
    this.bots.clear()
    this.credentials.clear()
  }
}
