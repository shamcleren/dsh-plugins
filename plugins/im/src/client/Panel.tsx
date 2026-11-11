import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import type { ConfigForm } from '@deepseek-ai/dsh-client-ui-settings/client'
import { WeChatCard } from '../adapters/wechat/client/Card.js'
import { WeComCard } from '../adapters/wecom/client/Card.js'
import type { WeChatCardController, WeChatCardState } from '../adapters/wechat/client/controller.js'
import type { WeComCardController, WeComCardState } from '../adapters/wecom/client/controller.js'
import type { CardApi } from '../adapters/wecom/client/api.js'
import type { Config as WeChatConfig } from '../adapters/wechat/config.js'
import type { Config as WeComConfig } from '../adapters/wecom/config.js'
import type { LocaleKey as WeChatLocaleKey } from '../adapters/wechat/client/locales.js'
import type { LocaleKey as WeComLocaleKey } from '../adapters/wecom/client/locales.js'
import type { IMAdapterView } from '../hub.js'
import type { LocaleKey } from './locales.js'
import { styles } from './forms.js'

type Store<T> = { subscribe(listener: () => void): () => void; getSnapshot(): T }
function useStore<T>(store: Store<T>): T { return useSyncExternalStore(listener => store.subscribe(listener), () => store.getSnapshot(), () => store.getSnapshot()) }

export interface PanelProps {
  t(key: LocaleKey): string
  wechatT(key: WeChatLocaleKey): string
  wecomT(key: WeComLocaleKey): string
  wechat: WeChatCardController
  wecom: WeComCardController
  wechatForm: ConfigForm<WeChatConfig>
  wecomForm: ConfigForm<WeComConfig>
  api: CardApi
  state(): Promise<IMAdapterView[]>
}

export function Panel(props: PanelProps) {
  const { t } = props
  const [platform, setPlatform] = useState('wechat'), [adapters, setAdapters] = useState<IMAdapterView[]>([])
  const [workspaces, setWorkspaces] = useState<readonly { workspaceId: string; title: string; path: string }[]>([])
  const [workspaceFailed, setWorkspaceFailed] = useState(false), [statusFailed, setStatusFailed] = useState(false)
  const [error, setError] = useState(false), [saving, setSaving] = useState(false)
  const [workspaceNameDraft, setWorkspaceNameDraft] = useState<string>()
  const mounted = useRef(true), pending = useRef(false), refreshing = useRef<Promise<void>>()
  const wechat = props.wechat.inject(), wecom = props.wecom.inject()
  const wechatState = useStore(wechat.hooks.weChatCard), wecomState = useStore(wecom.hooks.weComCard)
  const wechatForm = useStore(props.wechatForm), wecomForm = useStore(props.wecomForm)
  const scope = platform === 'wechat' ? props.wechatForm : props.wecomForm
  const snapshot = platform === 'wechat' ? wechatForm : wecomForm
  const nameDirty = workspaceNameDraft !== undefined && workspaceNameDraft !== (wechatForm.value?.workspaceName ?? '')
  const dirty = platform === 'wechat' ? wechatState.dirty || nameDirty : platform === 'wecom' ? wecomState.dirty : false
  const selected = adapters.find(adapter => adapter.id === platform)
  const knownPlatform = platform === 'wechat' || platform === 'wecom'
  const enabled = knownPlatform ? snapshot.value?.connectionEnabled === true : selected?.enabled === true
  const workspaceId = platform === 'wecom' ? wecomState.workspaceId.text : platform === 'wechat' ? wechatForm.value?.workspaceId ?? '' : ''
  const busy = saving || (platform === 'wechat' ? wechatState.saving : wecomState.saving)
  const change = async (work: () => Promise<boolean>) => {
    if (pending.current) return
    pending.current = true; setSaving(true); setError(false)
    try { if (!await work() && mounted.current) setError(true) }
    catch { if (mounted.current) setError(true) }
    finally { pending.current = false; if (mounted.current) setSaving(false) }
  }
  const refresh = (): Promise<void> => {
    if (refreshing.current) return refreshing.current
    const job = (async () => {
      try { const next = await props.state(); if (mounted.current) { setAdapters(next); setStatusFailed(false) } }
      catch { if (mounted.current) setStatusFailed(true) }
    })()
    refreshing.current = job
    void job.finally(() => { if (refreshing.current === job) refreshing.current = undefined })
    return job
  }
  useEffect(() => {
    mounted.current = true
    let disposed = false, timer: ReturnType<typeof setTimeout> | undefined
    const poll = async () => { await refresh(); if (!disposed) timer = setTimeout(() => { void poll() }, 5000) }
    void poll()
    void props.api.workspace.list({}).then(response => {
      if (!mounted.current) return
      if (response.result.ok) setWorkspaces(response.result.value.items)
      else setWorkspaceFailed(true)
    }).catch(() => { if (mounted.current) setWorkspaceFailed(true) })
    return () => { disposed = true; mounted.current = false; clearTimeout(timer) }
  }, [])
  const state = enabled ? selected?.enabled ? selected.status : 'starting' : 'disabled'
  const platforms = [...new Set(['wechat', 'wecom', ...adapters.map(adapter => adapter.id)])]
  return <section className="imw">
    <header className="imw-header"><div className="imw-heading"><span className="imw-brand" aria-hidden="true">IM</span><div><h2>{t('title')}</h2><p>{t('intro')}</p></div></div>
      <div className="imw-health"><span className={'imw-status is-' + state}>{t(('state_' + state) as LocaleKey)}</span><span>{selected?.accounts ?? 0} {t('accountCount')}</span><button className="imw-refresh" aria-label={t('refresh')} title={t('refresh')} onClick={() => { void refresh() }}>↻</button></div>
    </header>
    <div className="imw-routing">
      <div className="imw-field"><label htmlFor="imw-platform">{t('platform')}</label><select id="imw-platform" value={platform} disabled={dirty || busy} onChange={event => { setPlatform(event.target.value); setError(false) }}>{platforms.map(id => <option key={id} value={id}>{id === 'wechat' || id === 'wecom' ? t(id) : id}</option>)}</select></div>
      <div className="imw-field"><label id="imw-enabled-label">{t('reception')}</label><button className={'imw-enable' + (enabled ? ' is-enabled' : '')} role="switch" aria-checked={enabled} aria-labelledby="imw-enabled-label" title={t('enableHint')} disabled={!snapshot.writable || dirty || busy || !['wechat', 'wecom'].includes(platform)} onClick={() => { void change(() => scope.set('connectionEnabled', !enabled)) }}><span aria-hidden="true" />{t(enabled ? 'enabled' : 'disabled')}</button></div>
      <div className="imw-field"><label htmlFor="imw-workspace">{t('workspace')}</label><select id="imw-workspace" value={workspaceId} disabled={!knownPlatform || busy || workspaceFailed || !snapshot.writable || (platform === 'wechat' && dirty) || (platform === 'wecom' && !wecomState.writable)} onChange={event => { if (platform === 'wecom') wecom.edit('workspaceId', event.target.value); else void change(() => event.target.value === '' ? props.wechatForm.unset('workspaceId') : props.wechatForm.set('workspaceId', event.target.value)) }}>
        <option value="">{t('defaultWorkspace')}</option>{workspaceId && !workspaces.some(workspace => workspace.workspaceId === workspaceId) && <option value={workspaceId}>{t('missingWorkspace')}</option>}{workspaces.map(workspace => <option key={workspace.workspaceId} value={workspace.workspaceId}>{workspace.title}</option>)}
      </select></div>
      <p className="imw-routing-hint">{t(platform === 'wecom' ? 'workspaceHint' : 'enableHint')}</p>
    </div>
    {error && <p className="imw-notice is-error" role="alert">{t('saveFailed')}</p>}
    {statusFailed && <p className="imw-notice" role="status">{t('statusFailed')}</p>}
    {workspaceFailed && <p className="imw-notice is-error" role="status">{t('workspaceFailed')}</p>}
    {selected?.lastFailure && <p className="imw-notice is-error" role="status">{t('recentFailure')} · {t(('error_' + selected.lastFailure.kind) as LocaleKey)} · {new Date(selected.lastFailure.at).toLocaleTimeString()}</p>}
    <div className="imw-capabilities" aria-label={t('capabilities')}>{selected?.capabilities.map(capability => <span key={capability}>{t(('cap_' + capability) as LocaleKey)}</span>)}</div>
    <p className="imw-guidance">{dirty ? t('switchingHint') : t('setupHint')}</p>
    {platform === 'wechat' && <section style={{ ...styles.section, marginBottom: 16 }} aria-labelledby="imw-name-label">
      <label id="imw-name-label" htmlFor="imw-name" style={styles.label}>{t('workspaceName')}</label>
      <div className="imw-name-row"><input id="imw-name" style={styles.input} maxLength={80}
        value={workspaceNameDraft ?? wechatForm.value?.workspaceName ?? ''} placeholder={t('namePlaceholder')}
        disabled={!wechatForm.writable || busy} onChange={event => { setWorkspaceNameDraft(event.target.value); setError(false) }} />
        <button style={styles.save} disabled={!nameDirty || !wechatForm.writable || busy} onClick={() => { void change(async () => {
          const name = workspaceNameDraft?.trim() ?? ''
          const saved = name === '' ? await props.wechatForm.unset('workspaceName') : await props.wechatForm.set('workspaceName', name)
          if (saved && mounted.current) setWorkspaceNameDraft(undefined)
          return saved
        }) }}>{t('saveName')}</button>
        <button style={styles.button} disabled={!nameDirty || busy} onClick={() => { setWorkspaceNameDraft(undefined); setError(false) }}>{t('discardName')}</button>
      </div><p style={styles.hint}>{t('workspaceNameHint')}</p>
    </section>}
    {platform === 'wechat' && <WeChatCard {...wechat} t={props.wechatT} useWeChatCard={<T,>(select: (state: WeChatCardState) => T) => select(useStore(wechat.hooks.weChatCard))} beginLogin={() => {
      if (enabled) wechat.beginLogin()
      else void change(async () => { if (!await props.wechatForm.set('connectionEnabled', true)) return false; wechat.beginLogin(); return true })
    }} />}
    {platform === 'wecom' && <WeComCard {...wecom} embedded t={props.wecomT} useWeComCard={<T,>(select: (state: WeComCardState) => T) => select(useStore(wecom.hooks.weComCard))} />}
    <footer className="imw-commands"><strong>{t('commands')}</strong><p>{t('commandHint')}</p><code>/help</code><code>/workspace</code><code>/status</code><code>/new</code></footer>
  </section>
}
