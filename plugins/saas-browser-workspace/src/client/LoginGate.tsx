import { useEffect, useRef, useState } from 'react'
import type { Remote, Run } from '../contract.js'
import type { Translate } from '../locales.js'

/** Mounted in the shell, so collapsed tool traces and a closed sidebar cannot hide the handoff. */
export function LoginGate({ sessionId, remote, requests, t }: { sessionId: string; remote: Remote; requests: EventTarget; t: Translate }) {
  const [run, setRun] = useState<Run | null>(null)
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState('')
  const [blockedOrigin, setBlockedOrigin] = useState<string>()
  const latest = useRef<Run | null>(null)
  const seen = useRef('')
  const pending = useRef(false)
  const lifetime = useRef<AbortController>()
  const dialog = useRef<HTMLDialogElement>(null)
  const update = (next: Run | null) => {
    if (latest.current?.id === next?.id && (latest.current?.revision ?? 0) > (next?.revision ?? 0)) return
    latest.current = next; setRun(next)
    if (next?.status !== 'awaiting_login') { setOpen(false); return }
    const key = `${next.id}:${next.revision}`
    if (seen.current !== key) { seen.current = key; setNotice(''); setOpen(true) }
  }
  useEffect(() => {
    const controller = new AbortController(); lifetime.current = controller
    let timer: ReturnType<typeof setTimeout> | undefined
    const poll = async () => {
      try { const state = await remote.state(sessionId, controller.signal); if (!controller.signal.aborted) { update(state.run); setBlockedOrigin(state.blockedOrigin) } }
      catch { if (!controller.signal.aborted && latest.current?.status === 'awaiting_login') setNotice(t('error')) }
      finally { if (!controller.signal.aborted) timer = setTimeout(() => { void poll() }, 1200) }
    }
    const request = (event: Event) => { if ((event as CustomEvent<string>).detail === sessionId) setOpen(true) }
    requests.addEventListener('open', request); void poll()
    return () => { controller.abort(); clearTimeout(timer); requests.removeEventListener('open', request) }
  }, [sessionId, remote, requests, t])
  useEffect(() => {
    const element = dialog.current
    if (open && element && !element.open) element.showModal()
    else if (!open && element?.open) element.close()
    return () => { if (element?.open) element.close() }
  }, [open, run?.status])
  const perform = async (action: 'showLogin' | 'resume') => {
    const current = latest.current, controller = lifetime.current
    if (pending.current || current?.status !== 'awaiting_login' || !controller || controller.signal.aborted) return
    pending.current = true; setBusy(true); setNotice('')
    try {
      const request = { sessionId, runId: current.id, revision: current.revision }
      const next = action === 'showLogin' ? await remote.showLogin(request, controller.signal) : await remote.resume(request, controller.signal)
      if (!controller.signal.aborted) { update(next); if (action === 'showLogin') setNotice(t('loginShown')) }
    } catch (error) {
      if (!controller.signal.aborted) {
        const code = error instanceof Error ? error.message : ''
        setNotice(t(code === 'login-headless' ? 'loginHeadless' : code === 'stale-input' ? 'stale' : action === 'showLogin' ? 'loginUnavailable' : 'error'))
      }
    } finally { pending.current = false; if (!controller.signal.aborted) setBusy(false) }
  }
  if (run?.status !== 'awaiting_login') return null
  return <dialog ref={dialog} className="saas-login-dialog" aria-labelledby="saas-login-title" aria-describedby="saas-login-description"
    onCancel={event => { event.preventDefault(); if (!pending.current) setOpen(false) }}>
    <span className="saas-login-badge">{t('title')}</span>
    <h2 id="saas-login-title">{t('loginTitle')}</h2>
    <strong>{run.siteName}</strong>
    <p id="saas-login-description">{t('loginExplanation')}</p>
    <p className="saas-note">{t('loginCredentials')}</p>
    {blockedOrigin && <p className="saas-error" role="alert">{t('loginBlocked')}<br /><strong>{blockedOrigin}</strong><br />{t('loginBlockedHint')}</p>}
    {run.input.fields.keyword && <p className="saas-login-query">{t('keyword')}：{run.input.fields.keyword}</p>}
    <div className="saas-actions">
      <button className="saas-login-primary" autoFocus disabled={busy} onClick={() => { void perform('showLogin') }}>{t('loginShow')}</button>
      <button disabled={busy} onClick={() => { void perform('resume') }}>{t('resume')}</button>
      <button disabled={busy} onClick={() => setOpen(false)}>{t('loginLater')}</button>
    </div>
    {notice && <p role="status">{notice}</p>}
  </dialog>
}
