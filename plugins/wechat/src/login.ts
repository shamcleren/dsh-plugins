import { randomUUID } from 'node:crypto'
import type { Context, Logger } from '@deepseek-ai/cordis'
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import { DEFAULT_BASE_URL } from './config.js'
import { requestQrCode, requestQrStatus } from './api.js'
import type { QrStatusResponse, WeChatAccountCredentials } from './protocol.js'
import type { WeChatAccountStore } from './storage.js'

export interface WeChatLoginAccountView {
  accountId: string
  userId?: string
}

export interface WeChatReceiverView { status: 'waiting' | 'starting' | 'running' | 'failed'; accounts: number }

export type WeChatLoginView = {
  receiver?: WeChatReceiverView | undefined
  accounts: WeChatLoginAccountView[]
} & (
  | { status: 'idle' }
  | { status: 'qr'; flowId: string; qrUrl: string; expiresAt: number }
  | { status: 'scanned'; flowId: string; qrUrl: string; expiresAt: number }
  | { status: 'verification-required'; flowId: string; qrUrl: string; expiresAt: number }
  | { status: 'complete'; accountId: string }
  | { status: 'failed'; message: string }
)

interface LoginFlow {
  id: string
  qrCode: string
  qrUrl: string
  expiresAt: number
  baseUrl: string
  abort: AbortController
  verificationCode?: string
  verificationReady?: () => void
  phase: 'qr' | 'scanned' | 'verification-required'
}

function accountViews(store: WeChatAccountStore): WeChatLoginAccountView[] {
  return store.accounts([]).map(account => ({
    accountId: account.accountId,
    ...account.userId === undefined ? {} : { userId: account.userId },
  }))
}

/** Host-owned QR authorization state exposed to the settings card. */
export class WeChatLoginService extends TypertRemoteService {
  private flow: LoginFlow | undefined
  private settled: WeChatLoginView | undefined
  private pollTask: Promise<void> | undefined

  constructor(
    ctx: Context,
    private readonly store: WeChatAccountStore,
    private readonly logger: Logger,
    private readonly onAccountAdded: (account: WeChatAccountCredentials) => void | Promise<void>,
    private readonly receiver?: () => WeChatReceiverView,
  ) {
    super(ctx, 'wechatLogin')
    for (const initialize of LOGIN_REMOTE_INITIALIZERS) initialize.call(this)
    ctx.effect(() => async () => { await this.cancelFlow() }, 'wechat login flow')
  }

  /** Read browser-safe login status and locally authorized account ids. */
  state(): WeChatLoginView {
    return this.view()
  }

  /** Start or reuse one QR authorization flow. */
  async begin(): Promise<WeChatLoginView> {
    if (this.flow !== undefined) return this.view()
    let qr
    try {
      qr = await requestQrCode(DEFAULT_BASE_URL, this.store.tokens())
    } catch (error) {
      this.logger.error(error)
      this.settled = { accounts: accountViews(this.store), status: 'failed', message: '无法生成微信登录二维码，请稍后重试。' }
      return this.view()
    }
    const flow: LoginFlow = {
      id: randomUUID(),
      qrCode: qr.qrcode,
      qrUrl: qr.qrcode_img_content,
      expiresAt: Date.now() + 5 * 60_000,
      baseUrl: DEFAULT_BASE_URL,
      abort: new AbortController(),
      phase: 'qr',
    }
    this.flow = flow
    this.settled = undefined
    this.pollTask = this.poll(flow)
    void this.pollTask.catch((error: unknown) => { this.logger.error(error) })
    return this.view()
  }

  /** Submit the numeric confirmation requested by WeChat. */
  verify(code: string): WeChatLoginView {
    const flow = this.flow
    if (flow?.phase !== 'verification-required') throw new Error('wechat: no verification code is pending')
    const normalized = code.trim()
    if (!/^\d{1,8}$/u.test(normalized)) throw new Error('wechat: verification code must contain 1 to 8 digits')
    flow.verificationCode = normalized
    flow.verificationReady?.()
    delete flow.verificationReady
    flow.phase = 'scanned'
    return this.view()
  }

  /** Cancel the active QR flow without changing authorized accounts. */
  async cancel(): Promise<WeChatLoginView> {
    await this.cancelFlow()
    this.settled = undefined
    return this.view()
  }

  private view(): WeChatLoginView {
    const accounts = accountViews(this.store)
    const flow = this.flow
    if (flow !== undefined) {
      return { accounts, ...(this.receiver ? { receiver: this.receiver() } : {}), status: flow.phase, flowId: flow.id, qrUrl: flow.qrUrl, expiresAt: flow.expiresAt }
    }
    return { ...(this.settled ?? { status: 'idle' as const }), accounts, ...(this.receiver ? { receiver: this.receiver() } : {}) }
  }

  private async poll(flow: LoginFlow): Promise<void> {
    try {
      while (!flow.abort.signal.aborted && Date.now() < flow.expiresAt) {
        const response = await requestQrStatus(
          flow.baseUrl,
          flow.qrCode,
          flow.verificationCode,
          flow.abort.signal,
        )
        delete flow.verificationCode
        if (await this.applyStatus(flow, response)) return
      }
      if (!flow.abort.signal.aborted) this.fail(flow, '微信登录二维码已过期，请重新生成。')
    } catch (error) {
      if (!flow.abort.signal.aborted) {
        this.logger.error(error)
        this.fail(flow, '微信登录请求失败，请稍后重试。')
      }
    }
  }

  private async applyStatus(flow: LoginFlow, response: QrStatusResponse): Promise<boolean> {
    switch (response.status) {
      case 'wait': return false
      case 'scaned': flow.phase = 'scanned'; return false
      case 'scaned_but_redirect':
        if (response.redirect_host !== undefined) flow.baseUrl = `https://${response.redirect_host}`
        flow.phase = 'scanned'
        return false
      case 'need_verifycode': await this.waitForVerification(flow); return false
      case 'confirmed': await this.complete(flow, response); return true
      case 'expired': this.fail(flow, '微信登录二维码已过期，请重新生成。'); return true
      case 'verify_code_blocked': this.fail(flow, '验证码尝试次数过多，请稍后重试。'); return true
      case 'binded_redirect': this.fail(flow, '该微信已绑定，但本地没有可用凭据；请在原安装中解除绑定后重试。'); return true
    }
  }

  private async waitForVerification(flow: LoginFlow): Promise<void> {
    flow.phase = 'verification-required'
    await new Promise<void>(resolve => {
      flow.verificationReady = resolve
      flow.abort.signal.addEventListener('abort', () => { resolve() }, { once: true })
    })
  }

  private async complete(flow: LoginFlow, response: QrStatusResponse): Promise<void> {
    if (this.flow !== flow || flow.abort.signal.aborted) return
    if (response.ilink_bot_id === undefined || response.bot_token === undefined) {
      throw new Error('wechat: confirmed login omitted account id or token')
    }
    const account: WeChatAccountCredentials = {
      accountId: response.ilink_bot_id,
      token: response.bot_token,
      baseUrl: response.baseurl ?? flow.baseUrl,
      ...response.ilink_user_id === undefined ? {} : { userId: response.ilink_user_id },
    }
    await this.store.saveAccount(account)
    if (this.flow !== flow || flow.abort.signal.aborted) return
    try { await this.onAccountAdded(account) } catch (error) {
      this.logger.error(error)
      this.fail(flow, '微信账号已保存，但接收服务启动失败。请检查 Host 日志；缺少扫码身份时请重新绑定。')
      return
    }
    if (this.flow !== flow || flow.abort.signal.aborted) return
    this.flow = undefined
    this.settled = { accounts: accountViews(this.store), status: 'complete', accountId: account.accountId }
  }

  private fail(flow: LoginFlow, message: string): void {
    if (this.flow !== flow) return
    this.flow = undefined
    this.settled = { accounts: accountViews(this.store), status: 'failed', message }
  }

  private async cancelFlow(): Promise<void> {
    const flow = this.flow
    if (flow === undefined) return
    this.flow = undefined
    flow.abort.abort()
    flow.verificationReady?.()
    await this.pollTask
    this.pollTask = undefined
  }
}

const LOGIN_REMOTE_INITIALIZERS: Array<(this: WeChatLoginService) => void> = []

// Installed plugins do not run the Host repository's Typert compiler, so the
// emitted package registers the same standard-decorator initializers directly.
for (const method of ['state', 'begin', 'verify', 'cancel'] as const) {
  const remote = Remote(method)
  remote(
    WeChatLoginService.prototype[method] as (this: WeChatLoginService, ...args: unknown[]) => unknown,
    methodContext(method, LOGIN_REMOTE_INITIALIZERS),
  )
}

function methodContext<This extends object>(
  name: string,
  initializers: Array<(this: This) => void>,
): ClassMethodDecoratorContext<This, (this: This, ...args: unknown[]) => unknown> {
  return {
    kind: 'method',
    name,
    static: false,
    private: false,
    metadata: {},
    access: {
      has: object => name in object,
      get: object => (object as Record<string, unknown>)[name] as (this: This, ...args: unknown[]) => unknown,
    },
    addInitializer: initializer => { initializers.push(initializer) },
  }
}
