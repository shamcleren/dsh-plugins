type SnapshotStore<T> = { getSnapshot(): T; subscribe(listener: () => void): () => void; set(value: T): void; update(mutator: (value: T) => void): void }
import type { SettingsScope } from '@deepseek-ai/dsh-client-ui-settings/client'
import type { RemoteResult, TypertRemoteNamespaceMap } from '@deepseek-ai/dsh-typert-protocol'
import QRCode from 'qrcode/lib/browser.js'
import type { Config } from '../config.js'
import type { WeChatLoginView } from '../login.js'
type LoginRemote = TypertRemoteNamespaceMap['wechatLogin']

export interface PresetOption {
  id: string
  name?: string
  broken?: string
}

export interface PresetRosterApi {
  list(): Promise<{ result: RemoteResult<{ items: readonly PresetOption[]; defaultId?: string }> }>
}

export interface WeChatCardState {
  login: WeChatLoginView
  qrDataUrl?: string
  qrRenderError?: string
  loginBusy: boolean
  verificationCode: string
  writable: boolean
  dirty: boolean
  saving: boolean
  failed: boolean
  failureMessage?: string
  presetText: string
  presetOverridden: boolean
  presetOptions: readonly PresetOption[]
  presetsLoading: boolean
  presetsFailed: boolean
  presetDefaultId?: string
}

export interface WeChatCardFace {
  hooks: { weChatCard: SnapshotStore<WeChatCardState> }
  beginLogin(): void
  cancelLogin(): void
  refreshLogin(): void
  setVerificationCode(code: string): void
  submitVerification(): void
  editPreset(id: string): void
  savePreset(): void
  discardPreset(): void
}

/** Browser settings and QR login state for the WeChat card. */
export class WeChatCardController {
  private readonly state: SnapshotStore<WeChatCardState>
  private login: WeChatLoginView = { status: 'idle', accounts: [] }
  private qrDataUrl: string | undefined
  private qrRenderError: string | undefined
  private qrSource: string | undefined
  private loginBusy = false
  private verificationCode = ''
  private pollTimer: ReturnType<typeof setTimeout> | undefined
  private disposed = false

  private presetDraft: string | undefined
  private presetOptions: readonly PresetOption[] = []
  private presetsLoading = true
  private presetsFailed = false
  private presetDefaultId: string | undefined
  private saving = false
  private failed = false
  private failureMessage: string | undefined

  constructor(
    private readonly remote: LoginRemote,
    private readonly scope: SettingsScope<Config>,
    private readonly presets: PresetRosterApi,
  ) {
    this.state = createStore(this.snapshot())
    scope.subscribe(() => { this.publish() })
    this.refreshLogin()
    void this.readPresets()
  }

  inject(): WeChatCardFace {
    return {
      hooks: { weChatCard: this.state },
      beginLogin: () => { void this.mutate(() => this.remote.begin()) },
      cancelLogin: () => { void this.mutate(() => this.remote.cancel()) },
      refreshLogin: () => { this.refreshLogin() },
      setVerificationCode: code => {
        this.verificationCode = code.replace(/\D/gu, '').slice(0, 8)
        this.publish()
      },
      submitVerification: () => {
        const code = this.verificationCode
        if (code !== '') void this.mutate(() => this.remote.verify(code))
      },
      editPreset: id => {
        if (!this.scope.getSnapshot().writable || this.presetsFailed) return
        this.presetDraft = id
        this.failed = false
        this.failureMessage = undefined
        this.publish()
      },
      savePreset: () => { void this.savePreset() },
      discardPreset: () => {
        this.presetDraft = undefined
        this.failed = false
        this.failureMessage = undefined
        this.publish()
      },
    }
  }

  dispose(): void {
    this.disposed = true
    if (this.pollTimer !== undefined) clearTimeout(this.pollTimer)
  }

  private refreshLogin(): void {
    if (this.disposed || this.loginBusy) return
    void this.mutate(() => this.remote.state())
  }

  private async mutate(
    operation: () => Promise<RemoteResult<WeChatLoginView>>,
  ): Promise<void> {
    if (this.loginBusy) return
    this.loginBusy = true
    this.publish()
    try {
      this.applyLogin(unwrap(await operation()))
    } catch (error) {
      this.login = { status: 'failed', accounts: this.login.accounts, message: String(error) }
    } finally {
      this.loginBusy = false
      this.publish()
      this.schedulePoll()
    }
  }

  private applyLogin(login: WeChatLoginView): void {
    this.login = login
    if (login.status !== 'verification-required') this.verificationCode = ''
    if ('qrUrl' in login) this.renderQr(login.qrUrl)
    else {
      this.qrSource = undefined
      this.qrDataUrl = undefined
      this.qrRenderError = undefined
    }
  }

  private renderQr(source: string): void {
    if (this.qrSource === source) return
    this.qrSource = source
    this.qrDataUrl = undefined
    this.qrRenderError = undefined
    void QRCode.toString(source, { type: 'svg', width: 240, margin: 1 }).then(svg => {
      if (!this.disposed && this.qrSource === source) {
        this.qrDataUrl = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`
        this.publish()
      }
    }).catch((error: unknown) => {
      if (this.qrSource === source) {
        this.qrDataUrl = undefined
        this.qrRenderError = error instanceof Error ? error.message : String(error)
        this.publish()
      }
    })
  }

  private schedulePoll(): void {
    if (this.pollTimer !== undefined) clearTimeout(this.pollTimer)
    if (this.disposed || (!['qr', 'scanned', 'verification-required'].includes(this.login.status) && !this.login.accounts.length)) return
    this.pollTimer = setTimeout(() => {
      this.pollTimer = undefined
      this.refreshLogin()
    }, ['qr', 'scanned', 'verification-required'].includes(this.login.status) ? 1_000 : 5_000)
  }

  private async readPresets(): Promise<void> {
    this.presetsLoading = true
    this.presetsFailed = false
    this.publish()
    try {
      const response = await this.presets.list()
      if (!response.result.ok) {
        this.presetsFailed = true
        this.failureMessage = response.result.error.message
        return
      }
      this.presetOptions = response.result.value.items
      this.presetDefaultId = response.result.value.defaultId
    } catch (error) {
      this.presetsFailed = true
      this.failureMessage = error instanceof Error ? error.message : String(error)
    } finally {
      this.presetsLoading = false
      this.publish()
    }
  }

  private async savePreset(): Promise<void> {
    if (this.saving || this.presetDraft === undefined || !this.scope.getSnapshot().writable) return
    const next = this.presetDraft
    this.saving = true
    this.failed = false
    this.failureMessage = undefined
    this.publish()
    try {
      if (next === '') await this.scope.unset('agentPreset')
      else await this.scope.set('agentPreset', next)
      const user = this.scope.getSnapshot().user as { agentPreset?: string } | undefined
      const stored = user !== undefined && Object.hasOwn(user, 'agentPreset') ? user.agentPreset : ''
      if (stored !== next) {
        this.failed = true
        this.failureMessage = undefined
        return
      }
      this.presetDraft = undefined
    } catch (error) {
      this.failed = true
      this.failureMessage = error instanceof Error ? error.message : String(error)
    } finally {
      this.saving = false
      this.publish()
    }
  }

  private savedPreset(): string {
    const value = this.scope.getSnapshot().value?.agentPreset
    return typeof value === 'string' ? value : ''
  }

  private snapshot(): WeChatCardState {
    const saved = this.savedPreset()
    const user = this.scope.getSnapshot().user as { agentPreset?: string } | undefined
    return {
      login: this.login,
      ...this.qrDataUrl === undefined ? {} : { qrDataUrl: this.qrDataUrl },
      ...this.qrRenderError === undefined ? {} : { qrRenderError: this.qrRenderError },
      loginBusy: this.loginBusy,
      verificationCode: this.verificationCode,
      writable: this.scope.getSnapshot().writable,
      dirty: this.presetDraft !== undefined && this.presetDraft !== saved,
      saving: this.saving,
      failed: this.failed,
      ...this.failureMessage === undefined ? {} : { failureMessage: this.failureMessage },
      presetText: this.presetDraft ?? saved,
      presetOverridden: user !== undefined && Object.hasOwn(user, 'agentPreset'),
      presetOptions: this.presetOptions,
      presetsLoading: this.presetsLoading,
      presetsFailed: this.presetsFailed,
      ...this.presetDefaultId === undefined ? {} : { presetDefaultId: this.presetDefaultId },
    }
  }

  private publish(): void {
    this.state.set(this.snapshot())
  }
}

function unwrap<T>(result: RemoteResult<T>): T {
  if (result.ok) return result.value
  throw new Error(`${result.error.code}: ${result.error.message}`)
}

function createStore<S>(initial: S): SnapshotStore<S> {
  let snapshot = initial
  const listeners = new Set<() => void>()
  return {
    getSnapshot: () => snapshot,
    subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    set(next) {
      snapshot = next
      for (const listener of listeners) listener()
    },
    update(mutator) {
      const next = structuredClone(snapshot)
      mutator(next)
      snapshot = next
      for (const listener of listeners) listener()
    },
  }
}
