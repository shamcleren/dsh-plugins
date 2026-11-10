import { useEffect, useState } from 'react'
import type { Suppression, UiRemote } from '../ui-contract.js'
import { errorKey, type LocaleKey } from './locales.js'
type Props = { remote: UiRemote; t(key: LocaleKey): string; busy: boolean; action(operation: () => Promise<void>): Promise<void>; notify(message: string): void }
/** Settings section for user exclusions; it loads independently so a broken list never hides other settings. */
export function Suppressions({ remote, t, busy, action, notify }: Props) {
  const [items, setItems] = useState<Suppression[]>(), [error, setError] = useState(''), [query, setQuery] = useState('')
  const load = async () => { try { setItems(await remote.suppressions()); setError('') } catch (cause) { setError(cause instanceof Error ? cause.message : 'operation-failed') } }
  useEffect(() => { void load() }, [remote])
  const needle = query.trim().toLowerCase()
  const visible = (items ?? []).filter(item => [item.sourceLabel, item.file, item.reason, item.title, item.rule].join(' ').toLowerCase().includes(needle))
  return <section className="card suppressions" aria-label={t('suppressionsTitle')}>
    <div className="card-head"><div className="grow"><h3>{t('suppressionsTitle')}</h3><p className="muted">{t('suppressionsHint')}</p></div>{items ? <span className="tag">{items.length}</span> : null}</div>
    {error ? <p className="alert" role="alert">{t(errorKey(error))}</p> : !items ? <p role="status">{t('loading')}</p> : !items.length ? <p className="muted">{t('suppressionsEmpty')}</p> : <>
      {items.length > 5 ? <input className="search" aria-label={t('suppressionSearch')} placeholder={t('suppressionSearch')} value={query} onChange={event => setQuery(event.target.value)} /> : null}
      <div className="finding-list">{visible.map(item => <div className="finding-row" key={item.id}><span className="grow"><strong>{item.title}</strong><small>{item.sourceLabel} · {item.file} · {item.rule}</small><small>{new Date(item.createdAt).toLocaleDateString()} · {item.reason}</small></span>
        <button disabled={busy} aria-label={t('suppressionRestore') + ' ' + item.title} onClick={() => { void action(async () => {
          try { await remote.unsuppress(item.id); notify(t('suppressionRestored')) }
          finally { await load() }
        }) }}>{t('suppressionRestore')}</button></div>)}{!visible.length ? <p className="empty">{t('noMatches')}</p> : null}</div>
    </>}
  </section>
}
