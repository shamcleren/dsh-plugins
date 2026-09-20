import type { WeChatReceiverView } from './login.js'
import type { Logger } from '@deepseek-ai/cordis'
import type { Config, WeChatSettingsPatch } from './config.js'
import { resolveRuntimeConfig } from './config.js'
import { WeChatAccount } from './account.js'
import type { HostApiProxy } from './host-api.js'
import { WeChatConversationRouter } from './router.js'
import type { ChannelApprovalAnswer, ChannelApprovalRequest, RouterRuntimeContext } from './router.js'
import type { WeChatAccountStore } from './storage.js'
import type { WeChatAccountCredentials } from './protocol.js'
import { IdleSleepAssertion } from './wake.js'

interface ActiveAccount {
  account: WeChatAccount
  router: WeChatConversationRouter
}

interface ActiveRuntime {
  key: string
  accounts: ActiveAccount[]
  wake: IdleSleepAssertion | undefined
}

export interface WeChatRuntimeOptions {
  api: HostApiProxy
  logger: Logger
  store: WeChatAccountStore
  prepareContext(config: Config): Promise<RouterRuntimeContext>
  /** Persist a channel policy change made from a chat command. */
  writeSettings(section: WeChatSettingsPatch): Promise<void>
}

/** Keep all selected iLink accounts synchronized with live settings. */
export class WeChatRuntimeController {
  private failed = false
  private desired: Config = {}
  private generation = 0
  private stopped = false
  private active: ActiveRuntime | undefined
  private tail: Promise<void> = Promise.resolve()

  constructor(private readonly options: WeChatRuntimeOptions) {}

  update(config: Config): void {
    if (this.stopped) return
    this.failed = false
    this.desired = config
    const generation = ++this.generation
    this.tail = this.tail.then(() => this.reconcile(generation)).catch((error: unknown) => {
      if (generation === this.generation) this.failed = true
      this.options.logger.error(error)
    })
  }

  /** QR completion waits until settings have produced an active account runtime. */
  async ready(): Promise<void> {
    await this.tail
    if (this.active === undefined) throw new Error('wechat: account was saved but the runtime could not start')
  }

  state(): WeChatReceiverView {
    return { status: this.failed ? 'failed' : this.active ? 'running' : this.options.store.accounts([]).length ? 'starting' : 'waiting', accounts: this.active?.accounts.length ?? 0 }
  }

  routesSession(sessionId: string): boolean {
    return this.active?.accounts.some(active => active.router.routesSession(sessionId)) === true
  }

  ownsSession(sessionId: string): boolean {
    return this.active?.accounts.some(active => active.router.ownsSession(sessionId)) === true
  }

  async requestApproval(request: ChannelApprovalRequest): Promise<ChannelApprovalAnswer | undefined> {
    for (const active of this.active?.accounts ?? []) {
      const answer = await active.router.requestApproval(request)
      if (answer !== undefined) return answer
    }
    return undefined
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
    const accounts = this.options.store.accounts([])
    if (this.stopped || generation !== this.generation) return
    if (accounts.length === 0) {
      await this.stopActive()
      this.options.logger.warn('wechat: no authorized account; complete QR login in Plugins settings')
      return
    }
    // The preset is deliberately outside the key: `/preset` persists through the
    // settings service, which reconciles us back synchronously, and tearing the
    // account connections down there would drop the command's own reply.
    const { agentPreset, ...connectionPolicy } = resolveRuntimeConfig(config)
    const key = JSON.stringify([accounts, connectionPolicy, config.workspaceId, config.workspaceName])
    if (this.active?.key === key) {
      for (const active of this.active.accounts) active.router.setAgentPreset(agentPreset)
      return
    }
    await this.stopActive()
    if (this.stopped || generation !== this.generation) return
    await this.startActive(key, accounts, config)
  }

  private async startActive(
    key: string,
    credentials: WeChatAccountCredentials[],
    config: Config,
  ): Promise<void> {
    const context = await this.options.prepareContext(config)
    const accounts: ActiveAccount[] = []
    const wake = await IdleSleepAssertion.start(config.preventIdleSleep === true)
    try {
      for (const credential of credentials) {
        if (!credential.userId?.trim()) {
          throw new Error('wechat: scanning user identity is missing; reconnect the account to configure permissions automatically')
        }
        const runtimeConfig = resolveRuntimeConfig(config, credential.userId)
        let account: WeChatAccount
        const router = new WeChatConversationRouter(
          this.options.api,
          {
            sendText: (userId, text, token) => account.sendText(userId, text, token),
            sendImage: (userId, bytes, token) => account.sendImage(userId, bytes, token),
            typing: (userId, status, token) => account.typing(userId, status, token),
          },
          this.options.logger,
          runtimeConfig,
          context,
          section => this.options.writeSettings(section),
        )
        account = new WeChatAccount(
          credential,
          this.options.store,
          this.options.logger,
          runtimeConfig.mediaMaxBytes,
          message => router.accept(message),
        )
        router.start()
        account.start()
        accounts.push({ account, router })
      }
    } catch (error) {
      await Promise.allSettled(accounts.flatMap(active => [active.account.stop(), active.router.stop()]))
      await wake?.stop()
      throw error
    }
    this.active = { key, accounts, wake }
  }

  private async stopActive(): Promise<void> {
    const active = this.active
    if (active === undefined) return
    this.active = undefined
    await Promise.allSettled(active.accounts.flatMap(account => [account.account.stop(), account.router.stop()]))
    await active.wake?.stop()
  }
}
