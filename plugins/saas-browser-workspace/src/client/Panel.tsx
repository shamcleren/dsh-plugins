import { useCallback, useEffect, useRef, useState } from 'react'
import { GenuiActionContext, GenuiBlock, ErrorBoundary } from '@changfenhuang/dsh-genui/embed'
import { Fields, type Remote, type Run, type State, type BoundRequest } from '../contract.js'
import { formSpec, resultSpec } from './spec.js'
import type { Translate } from '../locales.js'

type View = 'form' | 'table' | 'list' | 'summary' | 'source'
export function Panel({ sessionId, remote, t, onLogin }: { sessionId: string; remote: Remote; t: Translate; onLogin: () => void }) {
  const [state, setState] = useState<State>()
  const [view, setView] = useState<View>('form')
  const [notice, setNotice] = useState('')
  const [busy, setBusy] = useState(false)
  const [formVersion, setFormVersion] = useState(0)
  const [image, setImage] = useState('')
  const [enlarged, setEnlarged] = useState(false)
  const alive = useRef(true)
  const currentInput = useRef('')
  const currentObservation = useRef('')
  const latest = useRef<State>()
  const update = useCallback((next: State) => {
    if (!alive.current) return
    if (latest.current?.run?.id === next.run?.id && (latest.current?.run?.revision ?? 0) > (next.run?.revision ?? 0)) return
    latest.current = next
    setState(next)
    if (next.run?.status === 'awaiting_input' && currentInput.current !== next.run.input.id) {
      currentInput.current = next.run.input.id; setView('form')
    } else if (next.run?.observation && currentObservation.current !== next.run.observation.id) {
      currentObservation.current = next.run.observation.id; setView(next.run.input.fields.view)
    }
  }, [])
  useEffect(() => {
    alive.current = true
    const controller = new AbortController()
    let disposed = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const poll = async () => {
      try { const next = await remote.state(sessionId, controller.signal); if (!disposed) update(next) }
      catch { if (!disposed) setNotice(t('error')) }
      finally { if (!disposed) timer = setTimeout(() => { void poll() }, 1200) }
    }
    void poll()
    return () => { disposed = true; alive.current = false; clearTimeout(timer); controller.abort() }
  }, [sessionId, remote, t, update])
  const run = state?.run
  const observation = run?.observation
  useEffect(() => {
    let disposed = false
    const controller = new AbortController()
    let url: string | undefined
    setImage('')
    if (run && observation) void remote.evidence(sessionId, run.id, observation.evidenceId, controller.signal).then(blob => {
      if (disposed) return
      url = URL.createObjectURL(blob); setImage(url)
    }).catch(() => { if (!disposed) setNotice(t('error')) })
    return () => { disposed = true; controller.abort(); if (url) URL.revokeObjectURL(url) }
  }, [sessionId, run?.id, observation?.evidenceId, remote, t])
  const perform = async (action: () => Promise<Run>) => {
    if (busy) return
    setBusy(true); setNotice('')
    try {
      await action()
      if (alive.current) update(await remote.state(sessionId))
    } catch (error) { if (alive.current) { setNotice(error instanceof Error && error.message === 'stale-input' ? t('stale') : t('error')); setFormVersion(value => value + 1) } }
    finally { if (alive.current) setBusy(false) }
  }
  if (!state) return <section className="saas-workspace"><p role="status">{notice || t('loading')}</p></section>
  const bound = (): BoundRequest => ({ sessionId, runId: run!.id, revision: run!.revision })
  const onAction = (action: string, payload: Record<string, unknown>) => {
    if (action !== 'submit-query' || !run || run.status !== 'awaiting_input' || busy) return
    const fields = typeof payload.fields === 'object' && payload.fields !== null ? payload.fields as Record<string, unknown> : {}
    const view = fields.view === t('table') ? 'table' : fields.view === t('list') ? 'list' : undefined
    const parsed = Fields.safeParse({ keyword: fields.keyword ?? '', view })
    if (!parsed.success || !view) { setNotice(t('keywordTooLong')); setFormVersion(value => value + 1); return }
    void perform(() => remote.submit({ ...bound(), inputId: run.input.id, fields: parsed.data }))
  }
  return <section className="saas-workspace" aria-label={t('title')}>
    <h2>{t('title')}</h2><div className="saas-note">{state.siteName}</div>
    {!state.configured && <p>{t('notConfigured')}</p>}
    {!run ? <p>{t('empty')}</p> : <>
      <p className="saas-status" role="status">{t(run.status)}</p>
      {state.blockedOrigin && <p className="saas-error" role="alert">{t('loginBlocked')}<br />{state.blockedOrigin}<br />{t('loginBlockedHint')}</p>}
      <div className="saas-actions">
        {run.status === 'awaiting_login' && <button disabled={busy} onClick={onLogin}>{t('loginPrompt')}</button>}
        {['succeeded', 'partial', 'failed', 'cancelled', 'interrupted'].includes(run.status) && <button disabled={busy} onClick={() => { void perform(() => remote.edit(bound())) }}>{t('edit')}</button>}
        {['awaiting_login', 'interrupted', 'failed'].includes(run.status) && <button disabled={busy} onClick={() => { void perform(() => remote.resume(bound())) }}>{run.status === 'awaiting_login' ? t('resume') : t('queryAgain')}</button>}
        {run.status === 'queued' && !run.input.accepted && <button disabled={busy} onClick={() => { void perform(() => remote.submit({ ...bound(), inputId: run.input.id, fields: run.input.fields })) }}>{t('retry')}</button>}
        {['awaiting_input', 'awaiting_login', 'queued', 'running'].includes(run.status) && <button disabled={busy} onClick={() => { void perform(() => remote.cancel(bound())) }}>{t('cancel')}</button>}
      </div>
      <div className="saas-tabs" role="tablist" aria-label={t('display')}>
        {(['form', 'table', 'list', 'summary', 'source'] as const).map(item => <button key={item} role="tab" aria-selected={view === item} onClick={() => setView(item)}>{t(item)}</button>)}
      </div>
      <div className="saas-result" role="tabpanel">
        {view === 'form' && (run.status === 'awaiting_input'
          ? <fieldset disabled={busy} style={{ border: 0, padding: 0 }}><GenuiActionContext.Provider value={onAction}><ErrorBoundary><GenuiBlock key={`${run.input.id}:${formVersion}`} spec={formSpec(run, t)} stateKey={`${sessionId}:${run.input.id}:${formVersion}`} animateEntrance={false} onStateChange={() => {}} /></ErrorBoundary></GenuiActionContext.Provider></fieldset>
          : <p>{t('keyword')}: {run.input.fields.keyword || '—'}</p>)}
        {['table', 'list', 'summary'].includes(view) && observation && <>
          {!['succeeded', 'partial'].includes(run.status) && <p className="saas-note">{t('previous')}</p>}
          <ErrorBoundary><GenuiBlock spec={resultSpec(observation, view as 'table' | 'list' | 'summary', t)} animateEntrance={false} /></ErrorBoundary>
          <p className="saas-note">{t('coverage')} {observation.truncated && t('truncated')}</p>
          <p className="saas-note">{t('capturedAt')}: {new Date(observation.capturedAt).toLocaleString()}</p>
        </>}
        {view === 'source' && <>
          {image ? <button className="saas-source-button" aria-label={t('enlarge')} onClick={() => setEnlarged(true)}><img className="saas-screenshot" src={image} alt={t('source')} /></button> : <p>{t('noScreenshot')}</p>}
          {observation && <p className="saas-note">{observation.title}<br />{observation.url}<br />{t('capturedAt')}: {new Date(observation.capturedAt).toLocaleString()}</p>}
          <p className="saas-note">{t('sourceNote')}</p>
        </>}
      </div>
    </>}
    {notice && <p className="saas-error" role="alert">{notice}</p>}
    {enlarged && image && <div className="saas-modal" role="dialog" aria-modal="true" aria-label={t('source')}><button autoFocus onClick={() => setEnlarged(false)}>{t('close')}</button><img className="saas-screenshot" src={image} alt={t('source')} /></div>}
  </section>
}
