/** WeCom settings scope and write-only credential projection for the browser card. */

import type { CardApi as IApiClient, PresetOption } from './api.js'
import type { ConfigForm, ConfigFormSnapshot } from '@deepseek-ai/dsh-client-ui-settings/client'
type SnapshotStore<T> = { getSnapshot(): T; subscribe(listener: () => void): () => void; set(value: T): void; update(mutator: (value: T) => void): void }
import { z } from 'zod'
import type { BotConfig, Config } from '../config.js'
import {
  booleanField, CardForm, numberField, stringListField, textField,
  type FieldState, type FormActions, type FormState,
} from './form.js'

const BOT_ID_FIELD = 'botId'
const SECRET_FIELD = 'secret'
const DEFAULT_BOT_ID_REF = 'WECOM_BOT_ID'
const DEFAULT_SECRET_REF = 'WECOM_BOT_SECRET'

interface CredentialState {
  ref: string
  configured: boolean
  writable: boolean
}

/**
 * Why one credential write did not leave the reference configured. A `message`
 * carries the deployment's own refusal text; its absence means the deployment
 * accepted the write and still reports the reference unconfigured.
 */
export interface CredentialFailure {
  ref: string
  message?: string
}

export interface WeComCardState extends FormState {
  bots: readonly { id: string; name?: string }[]
  selectedBotId: string
  rosterWritable: boolean
  multiBot: boolean
  model: FieldState
  name: FieldState
  botId: FieldState
  secret: FieldState
  allowedUsers: FieldState
  adminUsers: FieldState
  workspaceId: FieldState
  workspaceOptions: readonly WorkspaceOption[]
  workspacesLoading: boolean
  workspacesFailed: boolean
  presetOptions: readonly PresetOption[]
  presetsLoading: boolean
  presetsFailed: boolean
  presetDefaultId?: string
  preventIdleSleep: FieldState
  agentPreset: FieldState
  thinkingText: FieldState
  turnTimeoutMs: FieldState
  botIdConfigured: boolean
  botIdWritable: boolean
  secretConfigured: boolean
  secretWritable: boolean
  credentialFailure?: CredentialFailure
}

export type { PresetOption } from './api.js'

export interface WorkspaceOption {
  id: string
  title: string
  path: string
}

export interface WeComCardFace extends FormActions {
  selectBot(id: string): void
  addBot(): void
  removeBot(): void
  hooks: { weComCard: SnapshotStore<WeComCardState> }
}

/** Synchronizes one WeCom card with settings and credential stores. */
export class WeComCardController {
  private readonly form: CardForm<Config>
  private readonly scope: ConfigForm<Config>
  private selectedBotId = ''
  private readonly selectionListeners = new Set<() => void>()
  private readonly disposers: (() => void)[] = []
  private readonly store: SnapshotStore<WeComCardState>
  private botId: CredentialState = { ref: '', configured: false, writable: true }
  private secret: CredentialState = { ref: '', configured: false, writable: true }
  private workspaceOptions: readonly WorkspaceOption[] = []
  private workspacesLoading = true
  private workspacesFailed = false
  private presetOptions: readonly PresetOption[] = []
  private presetsLoading = true
  private presetsFailed = false
  private presetDefaultId: string | undefined
  private credentialFailure: CredentialFailure | undefined

  constructor(
    private readonly rootScope: ConfigForm<Config>,
    private readonly api: Pick<IApiClient, 'credentials' | 'workspace' | 'presets'>,
  ) {
    this.scope = botScope(rootScope, () => { this.selectedBotId ||= rootScope.getSnapshot().value?.bots?.[0]?.id ?? ''; return this.selectedBotId }, this.selectionListeners, this.disposers)
    this.form = new CardForm(
      this.scope,
      [
        textField('name'),
        { field: 'model',
          format: value => { const model = value as Config['model']; return model === undefined ? '' : [model.provider, model.model, model.reasoningEffort].filter(Boolean).join(' ') },
          parse: text => { const parts = text.trim().split(/\s+/u); return text.trim() === '' ? { kind: 'clear' as const }
            : parts.length < 2 || parts.length > 3 ? undefined : { kind: 'set' as const, value: { provider: parts[0], model: parts[1], ...(parts[2] === undefined ? {} : { reasoningEffort: parts[2] }) } } },
        },
        stringListField('allowedUsers'),
        stringListField('adminUsers'),
        textField('workspaceId'),
        booleanField('preventIdleSleep'),
        textField('agentPreset'),
        textField('thinkingText'),
        numberField('turnTimeoutMs'),
      ],
      [
        { field: BOT_ID_FIELD, write: value => this.writeCredential('botId', value) },
        { field: SECRET_FIELD, write: value => this.writeCredential('secret', value) },
      ],
    )
    this.store = this.form.bind(() => this.projection())
    this.disposers.push(this.scope.subscribe(() => { void this.readCredentials() }))
    void this.readCredentials()
    void this.readWorkspaces()
    void this.readPresets()
  }

  refreshCredential(ref: string): void {
    const refs = refsOf(this.scope.getSnapshot())
    if (ref === refs.botId || ref === refs.secret) void this.readCredentials()
  }

  inject(): WeComCardFace {
    const actions = this.form.actions()
    return {
      hooks: { weComCard: this.store },
      selectBot: id => {
        if (this.form.state().dirty) return
        this.selectedBotId = id
        for (const listener of this.selectionListeners) listener()
        this.store.set(this.projection())
      },
      addBot: () => { void this.changeRoster(false) },
      removeBot: () => { void this.changeRoster(true) },
      ...actions,
      discard: () => {
        this.credentialFailure = undefined
        actions.discard()
        this.store.set(this.projection())
      },
    }
  }

  dispose(): void { for (const dispose of this.disposers.splice(0)) dispose() }

  private activeBotId(): string {
    const bots = this.rootScope.getSnapshot().value?.bots
    return this.selectedBotId || bots?.[0]?.id || ''
  }

  private async changeRoster(remove: boolean): Promise<void> {
    if (this.form.state().dirty || !this.rootScope.getSnapshot().writable) return
    const snapshot = this.rootScope.getSnapshot()
    const current = snapshot.value ?? {}
    const { bots: configured, ...legacy } = current
    const bots: BotConfig[] = configured === undefined ? [{ ...legacy, id: 'default', botIdEnv: legacy.botIdEnv ?? DEFAULT_BOT_ID_REF, secretEnv: legacy.secretEnv ?? DEFAULT_SECRET_REF }] : [...configured]
    if (remove) {
      const index = bots.findIndex(bot => bot.id === this.activeBotId())
      if (index < 0) return
      bots.splice(index, 1)
    } else {
      const id = `bot_${crypto.randomUUID().replaceAll('-', '').slice(0, 12)}`
      bots.push({ id, botIdEnv: `WECOM_${id}_BOT_ID`, secretEnv: `WECOM_${id}_BOT_SECRET` })
    }
    try {
      const accepted = await this.rootScope.mutate([{ op: 'set', path: ['bots'], value: z.json().parse(JSON.parse(JSON.stringify(bots))) }], snapshot.revision)
      if (accepted) this.selectedBotId = remove ? bots[0]?.id ?? '' : bots.at(-1)?.id ?? ''
    } catch { /* Host refused: keep the accepted roster. */ }
    for (const listener of this.selectionListeners) listener()
    this.store.set(this.projection())
  }

  private projection(): WeComCardState {
    return {
      ...this.form.state(),
      bots: this.rootScope.getSnapshot().value?.bots ?? [],
      selectedBotId: this.activeBotId(),
      rosterWritable: this.rootScope.getSnapshot().writable,
      multiBot: this.rootScope.getSnapshot().value?.bots !== undefined,
      model: this.form.field('model'),
      name: this.form.field('name'),
      botId: this.form.field(BOT_ID_FIELD),
      secret: this.form.field(SECRET_FIELD),
      allowedUsers: this.form.field('allowedUsers'),
      adminUsers: this.form.field('adminUsers'),
      workspaceId: this.form.field('workspaceId'),
      workspaceOptions: this.workspaceOptions,
      workspacesLoading: this.workspacesLoading,
      workspacesFailed: this.workspacesFailed,
      presetOptions: this.presetOptions,
      presetsLoading: this.presetsLoading,
      presetsFailed: this.presetsFailed,
      ...this.presetDefaultId === undefined ? {} : { presetDefaultId: this.presetDefaultId },
      preventIdleSleep: this.form.field('preventIdleSleep'),
      agentPreset: this.form.field('agentPreset'),
      thinkingText: this.form.field('thinkingText'),
      turnTimeoutMs: this.form.field('turnTimeoutMs'),
      botIdConfigured: this.botId.configured,
      botIdWritable: this.botId.writable,
      secretConfigured: this.secret.configured,
      secretWritable: this.secret.writable,
      ...this.credentialFailure === undefined ? {} : { credentialFailure: this.credentialFailure },
    }
  }

  private async readWorkspaces(): Promise<void> {
    this.workspacesLoading = true
    this.workspacesFailed = false
    this.store.set(this.projection())
    try {
      const response = await this.api.workspace.list({})
      if (!response.result.ok) {
        this.workspacesFailed = true
        return
      }
      this.workspaceOptions = response.result.value.items.map(workspace => ({
        id: workspace.workspaceId,
        title: workspace.title,
        path: workspace.path,
      }))
    } catch (_workspaceReadFailure) {
      this.workspacesFailed = true
    } finally {
      this.workspacesLoading = false
      this.store.set(this.projection())
    }
  }

  private async readPresets(): Promise<void> {
    this.presetsLoading = true
    this.presetsFailed = false
    this.store.set(this.projection())
    try {
      const response = await this.api.presets.list({})
      if (!response.result.ok) {
        this.presetsFailed = true
        return
      }
      this.presetOptions = response.result.value.items
      this.presetDefaultId = response.result.value.defaultId
    } catch (_presetReadFailure) {
      this.presetsFailed = true
    } finally {
      this.presetsLoading = false
      this.store.set(this.projection())
    }
  }

  private async readCredentials(): Promise<void> {
    if (this.rootScope.getSnapshot().value?.bots !== undefined && this.scope.getSnapshot().value === undefined) {
      this.botId = { ref: '', configured: false, writable: false }
      this.secret = { ref: '', configured: false, writable: false }
      this.store.set(this.projection())
      return
    }
    const refs = refsOf(this.scope.getSnapshot())
    if (refs.botId !== this.botId.ref || refs.secret !== this.secret.ref) {
      this.botId = { ref: refs.botId, configured: false, writable: true }
      this.secret = { ref: refs.secret, configured: false, writable: true }
      this.store.set(this.projection())
    }
    let response: Awaited<ReturnType<IApiClient['credentials']['describe']>>
    try {
      response = await this.api.credentials.describe({ refs: [...new Set([refs.botId, refs.secret])] })
    } catch (_credentialReadFailure) {
      return
    }
    if (!response.result.ok) return
    const current = refsOf(this.scope.getSnapshot())
    if (current.botId !== refs.botId || current.secret !== refs.secret) return
    this.botId = credentialState(refs.botId, response.result.value.credentials[refs.botId])
    this.secret = credentialState(refs.secret, response.result.value.credentials[refs.secret])
    this.store.set(this.projection())
  }

  private async writeCredential(kind: 'botId' | 'secret', value: string): Promise<boolean> {
    if (this.rootScope.getSnapshot().value?.bots !== undefined && this.scope.getSnapshot().value === undefined) return false
    const ref = refsOf(this.scope.getSnapshot())[kind]
    this.credentialFailure = undefined
    let refusal: string | undefined
    try {
      const { result } = await this.api.credentials.set({ ref, value })
      if (!result.ok) refusal = result.error.message
    } catch (error: unknown) {
      refusal = error instanceof Error ? error.message : String(error)
    }
    await this.readCredentials()
    const configured = (kind === 'botId' ? this.botId : this.secret).configured
    if (!configured) {
      this.credentialFailure = { ref, ...refusal === undefined ? {} : { message: refusal } }
      this.store.set(this.projection())
    }
    return configured
  }
}

function refsOf(snapshot: ConfigFormSnapshot<Config>): { botId: string; secret: string } {
  return {
    botId: snapshot.value?.botIdEnv || DEFAULT_BOT_ID_REF,
    secret: snapshot.value?.secretEnv || DEFAULT_SECRET_REF,
  }
}

function credentialState(
  ref: string,
  view: { configured: boolean; writable: boolean } | undefined,
): CredentialState {
  return { ref, configured: view?.configured ?? false, writable: view?.writable ?? true }
}

/** Project a selected Bot and fence nested writes against roster changes. */
export function botScope(root: ConfigForm<Config>, selected: () => string,
  listeners: Set<() => void>, disposers: (() => void)[]): ConfigForm<Config> {
  const index = () => { const bots = root.getSnapshot().value?.bots; return bots === undefined ? undefined : selected() === '' ? 0 : bots.findIndex(bot => bot.id === selected()) }
  const layer = (value: unknown): Config | undefined => {
    const config = value as Config | undefined
    const i = index()
    if (i === undefined) return config
    const bot = config?.bots?.[i]
    if (bot === undefined) return undefined
    return { ...bot, botIdEnv: bot.botIdEnv ?? `WECOM_${bot.id}_BOT_ID`, secretEnv: bot.secretEnv ?? `WECOM_${bot.id}_BOT_SECRET` }
  }
  disposers.push(root.subscribe(() => { for (const listener of listeners) listener() }))
  const mutate: ConfigForm<Config>['mutate'] = (ops, revision) => {
    const snapshot = root.getSnapshot(), i = index()
    if (i !== undefined && snapshot.value?.bots?.[i] === undefined) return Promise.resolve(false)
    return root.mutate(ops.map(op => ({ ...op, path: [...(i === undefined ? [] : ['bots', String(i)]), ...op.path] })), revision ?? snapshot.revision)
  }
  return {
    getSnapshot: () => { const snapshot = root.getSnapshot(); return { ...snapshot, value: layer(snapshot.value), base: layer(snapshot.base), user: index() === undefined ? snapshot.user : (snapshot.user as Config | undefined)?.bots?.[index()!], writable: snapshot.writable && (index() === undefined || snapshot.value?.bots?.[index()!] !== undefined) } },
    subscribe: listener => { listeners.add(listener); return () => { listeners.delete(listener) } },
    mutate,
    set: (field, value) => index() === undefined ? root.set(field, value) : mutate([{ op: 'set', path: [field], value: z.json().parse(JSON.parse(JSON.stringify(value))) }]),
    unset: field => index() === undefined ? root.unset(field) : mutate([{ op: 'unset', path: [field] }]),
  }
}
