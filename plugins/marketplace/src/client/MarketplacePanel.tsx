import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { type CatalogFilter, pluginRows, visibleRows } from './model.ts'
import { requestNativeOpen, requestNativeRestart } from './native.ts'
import type { LocaleKey } from './locales.ts'
import type { CatalogView, MarketplaceRemote, MarketplaceState } from './types.ts'
import { connectSource } from './connect.ts'
import { DEFAULT_REPOSITORY_URL } from '../source.ts'
import css from './MarketplacePanel.module.css'

interface Props {
  readonly remote: MarketplaceRemote
  readonly t: (key: LocaleKey) => string
}

type View = 'catalog' | 'installed'

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Trusted catalog and installed-plugin management UI. */
export function MarketplacePanel({ remote, t }: Props): ReactNode {
  const [view, setView] = useState<View>('catalog')
  const [filter, setFilter] = useState<CatalogFilter>('all')
  const [query, setQuery] = useState('')
  const [state, setState] = useState<MarketplaceState>()
  const [catalog, setCatalog] = useState<CatalogView>()
  const [editing, setEditing] = useState(false)
  const [repositoryUrl, setRepositoryUrl] = useState(DEFAULT_REPOSITORY_URL)
  const [authorizationUrl, setAuthorizationUrl] = useState<string>()
  const connecting = useRef<AbortController>()
  const [busy, setBusy] = useState<string>()
  const [error, setError] = useState<string>()
  const [notice, setNotice] = useState<string>()
  const [restartPending, setRestartPending] = useState(false)

  const load = useCallback(async (refreshCatalog: boolean): Promise<void> => {
    setError(undefined)
    const nextState = await remote.state()
    setState(nextState)
    setRepositoryUrl(nextState.repositoryUrl)
    if (nextState.oauthConfigured) setCatalog(await (refreshCatalog ? remote.refreshCatalog() : remote.catalog()))
    else setCatalog(undefined)
  }, [remote])

  useEffect(() => {
    void load(false).catch((failure: unknown) => { setError(errorMessage(failure)) })
  }, [load])

  useEffect(() => () => { connecting.current?.abort() }, [])

  const rows = useMemo(() => pluginRows(catalog?.plugins ?? [], state?.installed ?? []), [catalog, state])
  const updates = useMemo(() => rows.filter(row => row.updateAvailable), [rows])
  const visible = useMemo(() => visibleRows(rows, query, filter), [filter, query, rows])
  const installedRows = useMemo(() => rows.filter(row => row.installed !== undefined), [rows])
  const unknownInstalled = useMemo(() => (state?.installed ?? []).filter(entry => !rows.some(row => row.installed?.packageName === entry.packageName)), [rows, state])

  const mutate = async (key: string, operation: () => Promise<unknown>): Promise<void> => {
    setBusy(key)
    setError(undefined)
    try {
      await operation()
      setRestartPending(true)
      setNotice(t('restartPending'))
      await load(false)
    } catch (failure) {
      setError(errorMessage(failure))
    } finally {
      setBusy(undefined)
    }
  }

  const refreshRemoteCatalog = async (): Promise<void> => {
    setBusy('refresh')
    setError(undefined)
    try {
      await load(true)
    } catch (failure) {
      setError(errorMessage(failure))
    } finally {
      setBusy(undefined)
    }
  }

  const updateAll = async (): Promise<void> => {
    setBusy('update-all')
    setError(undefined)
    let completed = 0
    try {
      for (const row of updates) {
        await remote.add(row.plugin.packageName)
        completed += 1
      }
    } catch (failure) {
      setError(`${t('partialUpdate')} ${errorMessage(failure)}`)
    } finally {
      if (completed > 0) {
        setRestartPending(true)
        setNotice(t('restartPending'))
        await load(false).catch((failure: unknown) => { setError(errorMessage(failure)) })
      }
      setBusy(undefined)
    }
  }

  const connect = async (authorize: boolean): Promise<void> => {
    connecting.current?.abort()
    const controller = new AbortController()
    connecting.current = controller
    setBusy('source')
    setError(undefined)
    setNotice(undefined)
    setAuthorizationUrl(undefined)
    try {
      await connectSource(remote, repositoryUrl, {
        authorize, signal: controller.signal, timeoutMessage: t('oauthExpired'),
        open: url => {
          setAuthorizationUrl(url)
          if (!requestNativeOpen(url)) window.open(url, '_blank', 'noopener,noreferrer')
        },
      })
      if (controller.signal.aborted) return
      await load(false)
      if (controller.signal.aborted) return
      setEditing(false)
      setNotice(t('oauthConnected'))
    } catch (failure) {
      if (!controller.signal.aborted) setError(errorMessage(failure))
    } finally {
      if (!controller.signal.aborted) {
        setBusy(undefined)
        setAuthorizationUrl(undefined)
      }
    }
  }

  const restart = (): void => {
    if (requestNativeRestart()) setNotice(t('restartSent'))
  }

  return <section className={css.root} aria-busy={busy !== undefined}>
    <header className={css.sourceCard}>
      <div>
        <div className={css.eyebrow}>{t('source')}</div>
        <strong>{state?.repositoryUrl ?? repositoryUrl}</strong>
        <div className={css.muted}>{state?.oauthConfigured === true ? t('connected') : t('disconnected')} · {t('sourceSummary')}</div>
      </div>
      <div className={css.actions}>
        <button type="button" disabled={busy !== undefined} onClick={() => { setEditing(!editing) }}>{t('configure')}</button>
        <button type="button" disabled={busy !== undefined || state?.oauthConfigured !== true} onClick={() => { void refreshRemoteCatalog() }}>{busy === 'refresh' ? t('working') : t('refresh')}</button>
      </div>
    </header>

    {state?.oauthConfigured === false ? <p className={css.notice}>{t('optionalSource')}</p> : null}

    {editing ? <div className={css.sourceForm}>
      <label>{t('repositoryUrl')}<input type="url" value={repositoryUrl} placeholder={DEFAULT_REPOSITORY_URL} disabled={busy !== undefined} onChange={event => { setRepositoryUrl(event.currentTarget.value) }} /></label>
      <p className={css.muted}>{t('sourceHint')}</p>
      <button type="button" disabled={busy !== undefined || repositoryUrl.trim() === ''} onClick={() => { void connect(state?.oauthConfigured !== true) }}>{busy === 'source' ? t('working') : state?.oauthConfigured === true ? t('save') : t('oauthLogin')}</button>
      {state?.oauthConfigured === true ? <button type="button" disabled={busy !== undefined} onClick={() => { void connect(true) }}>{t('oauthRelogin')}</button> : null}
      {authorizationUrl ? <a href={authorizationUrl} target="_blank" rel="noopener noreferrer">{t('openAuthorization')}</a> : null}
    </div> : null}

    <div className={css.stats} aria-label={t('tab')}>
      <div><span>{t('catalogCount')}</span><strong>{rows.length}</strong></div>
      <div><span>{t('installedCount')}</span><strong>{(state?.installed ?? []).length}</strong></div>
      <div><span>{t('updateCount')}</span><strong>{updates.length}</strong></div>
    </div>

    <div className={css.tabs} role="tablist">
      <button type="button" role="tab" aria-selected={view === 'catalog'} data-active={view === 'catalog' || undefined} onClick={() => { setView('catalog') }}>{t('available')}</button>
      <button type="button" role="tab" aria-selected={view === 'installed'} data-active={view === 'installed' || undefined} onClick={() => { setView('installed') }}>{t('installed')}</button>
    </div>

    {error === undefined ? null : <div className={css.error} role="alert"><span><strong>{t('error')}:</strong> {error}</span><button type="button" onClick={() => { void load(false).catch((failure: unknown) => { setError(errorMessage(failure)) }) }}>{t('retry')}</button></div>}
    {notice === undefined ? null : <div className={css.notice}><span>{notice}</span>{restartPending && state?.nativeRestartAvailable === true ? <button type="button" onClick={restart}>{t('restartNow')}</button> : null}</div>}

    {view === 'catalog' ? <>
      <div className={css.toolbar}>
        <input type="search" value={query} placeholder={t('search')} onChange={event => { setQuery(event.currentTarget.value) }} />
        <select value={filter} onChange={event => { setFilter(event.currentTarget.value as CatalogFilter) }} aria-label={t('compatible')}>
          <option value="all">{t('all')}</option><option value="compatible">{t('compatible')}</option><option value="updates">{t('updates')}</option>
        </select>
        <button type="button" disabled={updates.length === 0 || busy !== undefined} onClick={() => { void updateAll() }}>{busy === 'update-all' ? t('working') : `${t('updateAll')} (${updates.length})`}</button>
      </div>
      {visible.length === 0 ? <p className={css.empty}>{t('empty')}</p> : <ul className={css.grid}>{visible.map(row => <li key={row.plugin.packageName} className={css.pluginCard}>
        <div className={css.pluginHeader}><strong>{row.plugin.name}</strong>{row.installed === undefined ? null : <span className={css.badge}>{t('installedTag')}</span>}</div>
        <p>{row.plugin.description}</p>
        <code>{row.plugin.packageName}</code>
        <div className={css.meta}><span>v{row.plugin.version}</span><span>{row.plugin.dshVersion}</span></div>
        <div className={css.cardFooter}>
          {row.plugin.compatible ? null : <span className={css.incompatible}>{t('incompatible')}</span>}
          <button type="button" disabled={!row.plugin.compatible || (row.installed !== undefined && !row.updateAvailable) || busy !== undefined} onClick={() => { void mutate(row.plugin.packageName, () => remote.add(row.plugin.packageName)) }}>
            {busy === row.plugin.packageName ? t('working') : row.installed === undefined ? t('install') : t('update')}
          </button>
        </div>
      </li>)}</ul>}
    </> : installedRows.length === 0 && unknownInstalled.length === 0 ? <p className={css.empty}>{t('emptyInstalled')}</p> : <ul className={css.list}>
      {installedRows.map(row => <li key={row.plugin.packageName}>
        <div><strong>{row.plugin.name}</strong><code>{row.plugin.packageName} · {row.installed?.version ?? row.installed?.specifier}</code></div>
        <div className={css.actions}>{row.updateAvailable ? <button type="button" disabled={busy !== undefined} onClick={() => { void mutate(row.plugin.packageName, () => remote.add(row.plugin.packageName)) }}>{t('update')}</button> : null}<button className={css.danger} type="button" disabled={busy !== undefined} onClick={() => {
          if (window.confirm(t('confirmRemove'))) void mutate(row.plugin.packageName, () => remote.deletePackage(row.plugin.packageName))
        }}>{busy === row.plugin.packageName ? t('removing') : t('remove')}</button></div>
      </li>)}
      {unknownInstalled.map(entry => <li key={entry.packageName}><div><strong>{entry.packageName}</strong><code>{entry.version ?? entry.specifier}</code></div></li>)}
    </ul>}
  </section>
}
