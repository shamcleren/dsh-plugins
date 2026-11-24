import { ApprovalCard } from './ApprovalCard.js'
import { LiveBrowser } from './LiveBrowser.js'
import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { ErrorBoundary, GenuiActionContext, GenuiBlock, type GenuiSpec } from '@changfenhuang/dsh-genui/embed'
import type { AgentRemote, Question, PageObservation } from '../agent-contract.js'
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
function QueryResults({ observation, selectedId, canAct, select, t }: {
  observation: PageObservation
  selectedId: string | undefined
  canAct: boolean
  select: (id: string) => void
  t: AgentTranslate
}) {
  const { records, recordsState } = observation
  if (!records.length) return <p>{t(recordsState === 'loading' ? 'loadingRecords' : 'noRows')}</p>

  const counts = new Map<string, number>()
  for (const row of records) {
    if (row.type) counts.set(row.type, (counts.get(row.type) ?? 0) + 1)
  }
  return <>
    <div className="saas-query-meta saas-agent-caption">
      <span>{t('count')}: {records.length}</span>
      {!!counts.size && <details>
        <summary>{t('summary')}</summary>
        <ul>{Array.from(counts, ([type, count]) => <li key={type}>{type} · {count}</li>)}</ul>
      </details>}
    </div>
    <div className="saas-agent-list">
      {records.map(row => <article key={row.id} data-selected={selectedId === row.id}>
        <div>
          <span className="saas-agent-eyebrow">{[row.type, row.version].filter(Boolean).join(' · ')}</span>
          <h3>{row.name}</h3>
          {row.description && <p>{row.description}</p>}
          {!!row.tags.length && <div>{row.tags.map((tag, index) => <span className="saas-agent-tag" key={index}>{tag}</span>)}</div>}
        </div>
        <button aria-label={t('select') + ': ' + row.name} disabled={!canAct} onClick={() => select(row.id)}>{t('select')} →</button>
      </article>)}
    </div>
  </>
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
  const human = state?.phase === 'human'
  const login = human && state.humanReason === 'login'
  const hasPage = !!state?.browserReady || !!details
  const view = state?.view === 'results' ? 'results' : state?.view === 'details' || !listing && hasPage ? 'details' : 'queryResults'
  const canAct = connection === 'connected' && !busy && state?.phase === 'ready' && !state.agentRunning
  const action = (id: string) => { if (canAct && listing) void perform('select', { observationId: listing.id, recordId: id }) }
  const tabs = [...(listing ? ['queryResults'] as const : []), ...(hasPage ? ['details'] as const : []), ...(state?.executions.length ? ['results'] as const : [])]
  const status = state?.phase === 'ready' && state.agentRunning ? 'thinking' : state?.phase
  return <section className="saas-agent" aria-label={t('title')} aria-busy={busy}>
    <header className="saas-agent-heading"><div><span className="saas-agent-eyebrow">{t('title')}</span><h2>{state?.siteName || t('title')}</h2></div><span className="saas-agent-badge">{t(state?.approvalEnabled ? 'approvalEnabled' : state?.executionEnabled ? 'protected' : 'readonly')}</span></header>
    <div className="saas-agent-toolbar">
      <span role="status" className={'saas-agent-status ' + status}><i />{status ? t(status) : t('loading')}</span>
      <div className="saas-agent-tools">
        <button disabled={!state?.browserReady || connection !== 'connected' || busy || !!state.review}
          onClick={() => { void perform(human ? 'resume' : 'takeover', { revision: state?.revision }) }}>{t(human ? 'resume' : 'takeover')}</button>
        <button disabled={!state?.browserReady || connection !== 'connected'} onClick={openBrowser}>{t('browserExpand')} ↗</button>
      </div>
    </div>
    {connection === 'disconnected' && <div className="saas-agent-notice" role="alert"><p>{t('disconnected')}</p><button onClick={retry}>{t('retry')}</button></div>}
    {state && !state.configured && <p className="saas-agent-empty">{t('notConfigured')}</p>}
    {state?.selected && <div className="saas-agent-selection"><span className="saas-agent-eyebrow">{t('currentSelection')}</span><strong>{state.selected.name}</strong><span>{state.selected.type} · {state.selected.version}</span></div>}
    {!!state?.executionModes.length && <div className="saas-agent-actions">{state.executionModes.map(mode => <button key={mode} disabled={!canAct || !state.selected && !details} onClick={() => { void perform('execute', { mode }) }}>{t(mode)} →</button>)}{!state.selected && !details && <small>{t('selectFirst')}</small>}</div>}
    {state?.blockedOrigin && <div className="saas-agent-notice" role="alert">{t('blocked')} <code>{state.blockedOrigin}</code><p>{t('notAuthorized')}</p></div>}
    {(error || state?.error) && <p className="saas-agent-error" role="alert">{error || errorHint(state?.error, t)}</p>}
    {state?.review && <ApprovalCard key={state.review.id} review={state.review} remote={remote} sessionId={sessionId} t={t}
      disabled={busy || connection !== 'connected' || state.agentRunning || state.phase !== 'awaiting_approval'}
      decide={approve => { void perform(approve ? 'approve' : 'cancelApproval', { approvalId: state.review!.id }) }} />}
    {state?.operation === 'approval-cancelled' && <p role="status">{t('approvalCancelled')}</p>}
    {login && <p className="saas-agent-caption">{t('loginHelp')}</p>}
    {state?.question && <div className="saas-agent-prompt"><h3>{state.question.title}</h3><p className="saas-agent-caption">{t('requiredHelp')}</p><fieldset disabled={busy || state.phase !== 'awaiting_input' || connection !== 'connected'}><GenuiActionContext.Provider value={(name, payload) => {
      if (name !== 'answer' || busy || state.phase !== 'awaiting_input') return
      const fields = payload.fields && typeof payload.fields === 'object' ? payload.fields as Record<string, unknown> : {}
      if (state.question!.fields.some(field => field.required && !String(fields[field.name] ?? '').trim())) { setError(t('requiredHelp')); return }
      void perform('answer', { questionId: state.question!.id, answers: fields })
    }}><ErrorBoundary><GenuiBlock key={state.question.id} spec={questionSpec(state.question, t)} stateKey={sessionId + ':' + state.question.id} animateEntrance={false} /></ErrorBoundary></GenuiActionContext.Provider>{state.question.fields.every(field => !field.required) && <button disabled={busy || state.phase !== 'awaiting_input'} onClick={() => { void perform('answer', { questionId: state.question!.id, answers: {} }) }}>{t('skipOptional')}</button>}</fieldset></div>}
    {!tabs.length && state?.configured && state.phase !== 'human' && !state.question && !state.review && <div className="saas-agent-empty"><div>↗</div><p>{t(state.phase === 'queued' || state.phase === 'working' || state.agentRunning ? 'loadingRecords' : 'empty')}</p></div>}
    {!!tabs.length && <>
      <nav className="saas-agent-tabs" aria-label={t('title')}>
        {tabs.map(kind => <button key={kind} disabled={busy || connection !== 'connected'} aria-pressed={view === kind} onClick={() => { void perform('view', { view: kind === 'queryResults' ? 'table' : kind }) }}>{t(kind)}</button>)}
      </nav>
      {listing && view === 'queryResults' && <QueryResults observation={listing} selectedId={state?.selectedId} canAct={canAct} select={action} t={t} />}
      {view === 'details' && (state?.browserReady
        ? <LiveBrowser {...props} human={human && !busy && connection === 'connected'} keyboard={login} fit={!login} />
        : <p>{t('browserNotReady')}</p>)}
      {view === 'results' && <div className="saas-agent-executions"><p className="saas-agent-caption">{t('replyNotice')}</p>{state?.executions.map(run => <article key={run.id}><header><h3>{t(run.mode)}</h3><span className={'saas-run-status ' + run.status}>{t(run.status)}</span></header><h4>{t('message')}</h4><p>{run.input}</p><h4>{t('response')}</h4><pre>{run.output || t(run.status === 'running' ? 'waitingResponse' : 'noResponse')}</pre>{run.error && <p role="alert">{t('executionError')}: {errorHint(run.error, t)}<small>{run.error}</small></p>}<footer>{new Date(run.startedAt).toLocaleString()} · {run.url}</footer></article>)}{!state?.executions.length && <p>{t('noExecutions')}</p>}</div>}
      {view === 'queryResults' && <Source observation={listing} t={t} />}
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
  useEffect(() => { if (state?.review) setOpened(false) }, [state?.review?.id])
  const transfer = async () => {
    if (!state || transferring.current) return
    transferring.current = true; setBusy(true); setError('')
    try { await remote.call(human ? 'resume' : 'takeover', { sessionId, revision: state.revision }); retry(); if (human) setOpened(false) }
    catch (e) { setError(errorHint(e instanceof Error ? e.message : undefined, t)) }
    finally { transferring.current = false; setBusy(false) }
  }
  return <dialog ref={dialog} className="saas-browser-dialog" onCancel={() => setOpened(false)} onClose={() => setOpened(false)} aria-label={t('live')}>
    <header><div><strong>{t(human ? (login ? 'login' : 'human') : 'watch')}</strong><p>{t(human ? 'humanHelp' : 'watchHelp')}</p></div><div><button disabled={busy || connection !== 'connected' || !state?.browserReady || !!state.review} onClick={() => { void transfer() }}>{t(human ? 'resume' : 'takeover')}</button><button onClick={() => setOpened(false)}>{t('close')}</button></div></header>
    {error && <p role="alert">{error}</p>}{connection === 'disconnected' && <p role="alert">{t('disconnected')}</p>}{state?.blockedOrigin && <p role="alert">{t('blocked')} {state.blockedOrigin}</p>}
    {opened && state?.browserReady && <LiveBrowser {...props} human={human && !busy && connection === 'connected'} keyboard={login} />}
    <footer>{t(human && login ? 'loginInputNotice' : 'readOnlyNotice')}</footer>
  </dialog>
}
