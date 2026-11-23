import { PageContent } from './PageContent.js'
import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { ErrorBoundary, GenuiActionContext, GenuiBlock, type GenuiSpec } from '@changfenhuang/dsh-genui/embed'
import type { AgentRemote, HumanInput, Question, PageObservation } from '../agent-contract.js'
import type { AgentTranslate } from '../agent-locales.js'
import { plain } from './spec.js'
import { workspaceStore } from './workspace-store.js'
import { errorHint } from './agent-errors.js'

type Props = { sessionId: string; remote: AgentRemote; t: AgentTranslate }
function useWorkspace({ sessionId, remote }: Props) {
  const store = workspaceStore(remote, sessionId)
  return { ...useSyncExternalStore(store.subscribe, store.getSnapshot), retry: store.retry }
}
export function questionSpec(question: Question, t: AgentTranslate): GenuiSpec {
  return { items: [...question.fields.map(field => ({ type: field.type === 'textarea' ? 'textarea' as const : 'input' as const, id: field.name, label: plain(field.label + (field.required ? ' · ' + t('required') : '')), ...(field.type === 'textarea' ? { rows: 4 } : {}) })), { type: 'submit', action: 'answer', label: t('submit'), groups: question.fields.filter(field => field.required).map(field => field.name) }] }
}
function Source({ observation, t }: { observation: PageObservation | undefined; t: AgentTranslate }) {
  return observation ? <footer className="saas-agent-source">{observation.recordsState !== 'unavailable' && <span>{t('scope')}</span>}{observation.truncated && <strong>{t('truncated')}</strong>}<span>{t('captured')}: {new Date(observation.capturedAt).toLocaleString()}</span><span>{t('source')}: {observation.url}</span></footer> : null
}
export function AgentPanel(props: Props & { openBrowser: () => void }) {
  const { remote, sessionId, t, openBrowser } = props, { state, connection, retry } = useWorkspace(props)
  const [error, setError] = useState(''), [busy, setBusy] = useState(false), inFlight = useRef(false)
  const perform = async (method: string, extra: Record<string, unknown>) => {
    if (inFlight.current || connection !== 'connected') return
    inFlight.current = true; setBusy(true); setError('')
    try { await remote.call(method, { sessionId, ...extra }); retry() }
    catch (e) { setError(errorHint(e instanceof Error ? e.message : undefined, t)) }
    finally { inFlight.current = false; setBusy(false) }
  }
  const listing = state?.listing ?? (state?.observation?.recordsState !== 'unavailable' ? state?.observation : undefined)
  const details = state?.details ?? (state?.observation?.recordsState === 'unavailable' ? state.observation : undefined)
  const records = listing?.records ?? [], view = !listing && details && state?.view !== 'results' ? 'details' : state?.view ?? 'table'
  const layout = useRef('table')
  const queryView = ['table', 'list', 'summary'].includes(view)
  if (queryView) layout.current = view
  const canAct = connection === 'connected' && !busy && state?.phase === 'ready' && !state.agentRunning
  const action = (id: string) => { if (canAct && listing) void perform('select', { observationId: listing.id, recordId: id }) }
  const counts: Record<string, number> = {}; for (const row of records) counts[row.type] = (counts[row.type] ?? 0) + 1
  const tabs = [...(listing ? ['queryResults'] as const : []), ...(details ? ['details'] as const : []), ...(state?.executions.length ? ['results'] as const : [])]
  const status = state?.phase === 'ready' && state.agentRunning ? 'thinking' : state?.phase
  return <section className="saas-agent" aria-label={t('title')} aria-busy={busy}>
    <header className="saas-agent-heading"><div><span className="saas-agent-eyebrow">{t('title')}</span><h2>{state?.siteName || t('title')}</h2></div><span className="saas-agent-badge">{t(state?.executionEnabled ? 'protected' : 'readonly')}</span></header>
    <div className="saas-agent-toolbar"><span role="status" className={'saas-agent-status ' + status}><i />{status ? t(status) : t('loading')}</span><button disabled={!state?.browserReady || connection !== 'connected'} onClick={openBrowser}>{t('browser')} ↗</button></div>
    {connection === 'disconnected' && <div className="saas-agent-notice" role="alert"><p>{t('disconnected')}</p><button onClick={retry}>{t('retry')}</button></div>}
    {state && !state.configured && <p className="saas-agent-empty">{t('notConfigured')}</p>}
    {state?.selected && <div className="saas-agent-selection"><span className="saas-agent-eyebrow">{t('currentSelection')}</span><strong>{state.selected.name}</strong><span>{state.selected.type} · {state.selected.version}</span></div>}
    {!!state?.executionModes.length && <div className="saas-agent-actions">{state.executionModes.map(mode => <button key={mode} disabled={!canAct || !state.selected && !details} onClick={() => { void perform('execute', { mode }) }}>{t(mode)} →</button>)}{!state.selected && !details && <small>{t('selectFirst')}</small>}</div>}
    {state?.blockedOrigin && <div className="saas-agent-notice" role="alert">{t('blocked')} <code>{state.blockedOrigin}</code><p>{t('notAuthorized')}</p></div>}
    {(error || state?.error) && <p className="saas-agent-error" role="alert">{error || errorHint(state?.error, t)}</p>}
    {state?.phase === 'human' && <div className="saas-agent-prompt"><h3>{t(state.humanReason === 'login' ? 'login' : 'human')}</h3><p>{t(state.humanReason === 'login' ? 'loginHelp' : 'humanHelp')}</p><button onClick={openBrowser}>{t('browser')}</button></div>}
    {state?.question && <div className="saas-agent-prompt"><h3>{state.question.title}</h3><p className="saas-agent-caption">{t('requiredHelp')}</p><fieldset disabled={busy || state.phase !== 'awaiting_input' || connection !== 'connected'}><GenuiActionContext.Provider value={(name, payload) => {
      if (name !== 'answer' || busy || state.phase !== 'awaiting_input') return
      const fields = payload.fields && typeof payload.fields === 'object' ? payload.fields as Record<string, unknown> : {}
      if (state.question!.fields.some(field => field.required && !String(fields[field.name] ?? '').trim())) { setError(t('requiredHelp')); return }
      void perform('answer', { questionId: state.question!.id, answers: fields })
    }}><ErrorBoundary><GenuiBlock key={state.question.id} spec={questionSpec(state.question, t)} stateKey={sessionId + ':' + state.question.id} animateEntrance={false} /></ErrorBoundary></GenuiActionContext.Provider>{state.question.fields.every(field => !field.required) && <button disabled={busy || state.phase !== 'awaiting_input'} onClick={() => { void perform('answer', { questionId: state.question!.id, answers: {} }) }}>{t('skipOptional')}</button>}</fieldset></div>}
    {!tabs.length && state?.configured && state.phase !== 'human' && !state.question && <div className="saas-agent-empty"><div>↗</div><p>{t(state.phase === 'queued' || state.phase === 'working' || state.agentRunning ? 'loadingRecords' : 'empty')}</p></div>}
    {!!tabs.length && <>
      <nav className="saas-agent-tabs" aria-label={t('title')}>{tabs.map(kind => <button key={kind} disabled={busy || connection !== 'connected'} aria-pressed={kind === 'queryResults' ? queryView : view === kind} onClick={() => { void perform('view', { view: kind === 'queryResults' ? layout.current : kind }) }}>{t(kind)}</button>)}</nav>
      {listing && queryView && <div className="saas-page-modes" role="group" aria-label={t('resultLayout')}>{(['table', 'list', 'summary'] as const).map(kind => <button key={kind} disabled={busy || connection !== 'connected'} aria-pressed={view === kind} onClick={() => { void perform('view', { view: kind }) }}>{t(kind)}</button>)}</div>}
      {listing && ['table', 'list', 'summary'].includes(view) && <p className="saas-agent-caption">{t('retained')} · {records.length} </p>}
      {view === 'table' && <div className="saas-agent-table"><table><thead><tr><th>{t('name')}</th><th>{t('type')}</th><th>{t('version')}</th><th>{t('viewAction')}</th></tr></thead><tbody>{records.map(row => <tr key={row.id} data-selected={state?.selectedId === row.id}><td><strong>{row.name}</strong><small>{row.description}</small></td><td>{row.type}</td><td>{row.version}</td><td><button aria-label={t('select') + ': ' + row.name} disabled={!canAct} onClick={() => action(row.id)}>{t('select')} →</button></td></tr>)}</tbody></table>{!records.length && <p>{t(listing?.recordsState === 'loading' ? 'loadingRecords' : 'noRows')}</p>}</div>}
      {view === 'list' && <div className="saas-agent-list">{records.map(row => <article key={row.id} data-selected={state?.selectedId === row.id}><div><span className="saas-agent-eyebrow">{row.type} · {row.version}</span><h3>{row.name}</h3><p>{row.description}</p><div>{row.tags.map((tag, index) => <span className="saas-agent-tag" key={index}>{tag}</span>)}</div></div><button aria-label={t('select') + ': ' + row.name} disabled={!canAct} onClick={() => action(row.id)}>{t('select')} →</button></article>)}{!records.length && <p>{t('noRows')}</p>}</div>}
      {view === 'summary' && <ErrorBoundary><GenuiBlock animateEntrance={false} spec={{ items: [{ type: 'stat', label: t('count'), value: String(records.length), size: 'hero' }, ...Object.entries(counts).map(([type, count]) => ({ type: 'progress' as const, label: plain(type), value: records.length ? count * 100 / records.length : 0, valueLabel: String(count) }))] }} /></ErrorBoundary>}
      {view === 'details' && (details ? <PageContent key={details.id} observation={details} t={t} current={!!state?.browserReady && state.phase === 'ready' && !state.agentRunning && connection === 'connected' && details.url === state.observation?.url} preview={<LiveBrowser {...props} human={false} interval={1800} />} openBrowser={openBrowser} /> : <p>{t('missingDetails')}</p>)}
      {view === 'results' && <div className="saas-agent-executions"><p className="saas-agent-caption">{t('replyNotice')}</p>{state?.executions.map(run => <article key={run.id}><header><h3>{t(run.mode)}</h3><span className={'saas-run-status ' + run.status}>{t(run.status)}</span></header><h4>{t('message')}</h4><p>{run.input}</p><h4>{t('response')}</h4><pre>{run.output || t(run.status === 'running' ? 'waitingResponse' : 'noResponse')}</pre>{run.error && <p role="alert">{t('executionError')}: {errorHint(run.error, t)}<small>{run.error}</small></p>}<footer>{new Date(run.startedAt).toLocaleString()} · {run.url}</footer></article>)}{!state?.executions.length && <p>{t('noExecutions')}</p>}</div>}
      {view !== 'results' && <Source observation={view === 'details' ? details : listing} t={t} />}
    </>}
  </section>
}

export function BrowserOverlay(props: Props & { requests: EventTarget }) {
  const { sessionId, remote, t, requests } = props, { state, connection, retry } = useWorkspace(props)
  const dialog = useRef<HTMLDialogElement>(null), seen = useRef(false), [opened, setOpened] = useState(false)
  const [error, setError] = useState(''), [busy, setBusy] = useState(false), transferring = useRef(false)
  useEffect(() => {
    const show = (event: Event) => { if ((event as CustomEvent<string>).detail === sessionId) setOpened(true) }
    requests.addEventListener('open', show); return () => requests.removeEventListener('open', show)
  }, [requests, sessionId])
  const login = state?.phase === 'human' && state.humanReason === 'login'
  useEffect(() => { if (login && !seen.current) setOpened(true); seen.current = login }, [login])
  useEffect(() => { if (opened && dialog.current && !dialog.current.open) dialog.current.showModal(); if (!opened) dialog.current?.close() }, [opened])
  const human = state?.phase === 'human'
  const transfer = async () => {
    if (!state || transferring.current) return
    transferring.current = true; setBusy(true); setError('')
    try { await remote.call(human ? 'resume' : 'takeover', { sessionId, revision: state.revision }); retry(); if (human) setOpened(false) }
    catch (e) { setError(errorHint(e instanceof Error ? e.message : undefined, t)) }
    finally { transferring.current = false; setBusy(false) }
  }
  return <dialog ref={dialog} className="saas-browser-dialog" onCancel={() => setOpened(false)} onClose={() => setOpened(false)} aria-label={t('live')}>
    <header><div><strong>{t(human ? (login ? 'login' : 'human') : 'watch')}</strong><p>{t(human ? 'humanHelp' : 'watchHelp')}</p></div><div><button disabled={busy || connection !== 'connected' || !state?.browserReady} onClick={() => { void transfer() }}>{t(human ? 'resume' : 'takeover')}</button><button onClick={() => setOpened(false)}>{t('close')}</button></div></header>
    {error && <p role="alert">{error}</p>}{connection === 'disconnected' && <p role="alert">{t('disconnected')}</p>}{state?.blockedOrigin && <p role="alert">{t('blocked')} {state.blockedOrigin}</p>}
    {opened && state?.browserReady && <LiveBrowser {...props} human={human && !busy && connection === 'connected'} />}
    <footer>{t(human && login ? 'loginInputNotice' : 'readOnlyNotice')}</footer>
  </dialog>
}
function LiveBrowser({ sessionId, remote, t, human, interval = 400 }: Props & { human: boolean; interval?: number }) {
  const [src, setSrc] = useState(''), [error, setError] = useState(''), [connected, setConnected] = useState(false)
  const queue = useRef(Promise.resolve()), permission = useRef({ allowed: false, epoch: 0 })
  const allowed = human && connected
  if (permission.current.allowed !== allowed) permission.current = { allowed, epoch: permission.current.epoch + 1 }
  useEffect(() => {
    const abort = new AbortController(); let timer: ReturnType<typeof setTimeout>, current = ''
    const frame = async () => {
      try {
        const blob = await remote.frame(sessionId, abort.signal)
        if (!abort.signal.aborted) { const old = current; current = URL.createObjectURL(blob); setSrc(current); setConnected(true); if (old) URL.revokeObjectURL(old) }
      } catch { if (!abort.signal.aborted) setConnected(false) }
      if (!abort.signal.aborted) timer = setTimeout(() => { void frame() }, interval)
    }
    void frame(); return () => { permission.current = { allowed: false, epoch: permission.current.epoch + 1 }; abort.abort(); clearTimeout(timer); if (current) URL.revokeObjectURL(current) }
  }, [sessionId, remote, interval])
  const send = (input: HumanInput) => {
    if (!permission.current.allowed) return
    const epoch = permission.current.epoch
    queue.current = queue.current.then(async () => { if (permission.current.allowed && permission.current.epoch === epoch) await remote.call('input', { sessionId, input }) }).catch(e => { if (permission.current.epoch === epoch) setError(errorHint(e instanceof Error ? e.message : undefined, t)) })
  }
  return <div className="saas-live-browser" data-stale={!connected}>
    {!connected && <p role="status" className="saas-frame-notice">{t(src ? 'frameLost' : 'frameLoading')}</p>}
    {error && <p role="alert">{error}</p>}
    {src && <img src={src} alt={t('live')} tabIndex={allowed ? 0 : -1} draggable={false} aria-disabled={!allowed} onPointerDown={event => {
      if (!allowed) return
      event.preventDefault(); event.currentTarget.focus(); const rect = event.currentTarget.getBoundingClientRect()
      send({ kind: 'click', x: Math.min(1280, Math.max(0, (event.clientX - rect.left) * 1280 / rect.width)), y: Math.min(900, Math.max(0, (event.clientY - rect.top) * 900 / rect.height)) })
    }} onWheel={event => { if (allowed) send({ kind: 'scroll', delta: Math.max(-1200, Math.min(1200, Math.round(event.deltaY))) }) }} onKeyDown={event => {
      if (!allowed || event.nativeEvent.isComposing || event.key === 'Escape' || event.key === 'Tab' && event.shiftKey) return
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'a') { event.preventDefault(); send({ kind: 'key', key: 'ControlOrMeta+A' }); return }
      const key = (['Enter', 'Tab', 'Backspace', 'Delete', 'Escape', 'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End'] as const).find(k => k === event.key)
      if (key) { event.preventDefault(); send({ kind: 'key', key }) }
      else if (event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey) { event.preventDefault(); send({ kind: 'text', text: event.key }) }
    }} onCompositionEnd={event => { if (event.data) send({ kind: 'text', text: event.data }) }} onPaste={event => { event.preventDefault(); send({ kind: 'text', text: event.clipboardData.getData('text/plain') }) }} />}
  </div>
}
