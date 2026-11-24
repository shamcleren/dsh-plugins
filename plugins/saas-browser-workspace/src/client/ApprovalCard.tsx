import { useEffect, useRef, useState } from 'react'
import type { ActionReview, AgentRemote } from '../agent-contract.js'
import type { AgentTranslate } from '../agent-locales.js'

export function ApprovalCard({ review, remote, sessionId, t, disabled, decide }: {
  review: ActionReview
  remote: AgentRemote
  sessionId: string
  t: AgentTranslate
  disabled: boolean
  decide: (approve: boolean) => void
}) {
  const zoom = useRef<HTMLDialogElement>(null)
  const [src, setSrc] = useState('')
  const [loaded, setLoaded] = useState(false)
  const [failed, setFailed] = useState(false)
  useEffect(() => {
    const abort = new AbortController()
    let objectUrl = ''
    void remote.frame(sessionId, abort.signal, review.id).then(blob => {
      if (abort.signal.aborted) return
      objectUrl = URL.createObjectURL(blob)
      setSrc(objectUrl)
    }).catch(() => { if (!abort.signal.aborted) setFailed(true) })
    return () => { abort.abort(); if (objectUrl) URL.revokeObjectURL(objectUrl) }
  }, [remote, sessionId, review.id])

  const action = t(review.action === 'click' ? 'approvalClick' : review.action === 'fill' ? 'approvalFill' : 'approvalSelect')
  const { left, top, width, height } = review.target
  const marker = <span aria-hidden="true" style={{ left: left + '%', top: top + '%', width: width + '%', height: height + '%' }} />
  return <section className="saas-agent-prompt saas-approval" aria-label={t('approvalTitle')}>
    <h3>{t('approvalTitle')}</h3>
    <strong>{action} · {review.label}</strong>
    <p className="saas-agent-caption">{review.pageTitle} · {review.url}</p>
    <p>{t('approvalContext')}</p>
    {src && !failed && <figure>
      <img src={src} alt={t('approvalImage')} onLoad={() => setLoaded(true)} onError={() => setFailed(true)} />
      {loaded && marker}
    </figure>}
    {loaded && !failed && <>
      <button onClick={() => zoom.current?.showModal()}>{t('expandOriginal')} ↗</button>
      <dialog ref={zoom} className="saas-browser-dialog" aria-label={t('approvalImage')}>
        <header><strong>{t('approvalImage')}</strong><button onClick={() => zoom.current?.close()}>{t('close')}</button></header>
        <figure><img src={src} alt={t('approvalImage')} />{marker}</figure>
      </dialog>
    </>}
    {!loaded && <p role="status">{t(failed ? 'approvalLost' : 'approvalLoading')}</p>}
    {review.action !== 'click' && <dl>
      <dt>{t('approvalBefore')}</dt><dd>{review.before || t('emptyValue')}</dd>
      <dt>{t('approvalAfter')}</dt><dd>{review.after || t('emptyValue')}</dd>
    </dl>}
    {!!review.fields.length && <details>
      <summary>{t('approvalFields')} · {review.fields.length}</summary>
      {review.fieldsLimited && <p>{t('approvalFieldsLimited')}</p>}
      <dl>{review.fields.map((field, index) => <div key={index}>
        <dt>{field.label || t(field.state === 'redacted' ? 'privateField' : 'unnamedField')}</dt>
        <dd>{field.state === 'value' ? field.checked ? t(field.checked) : field.value : t(field.state === 'empty' ? 'emptyValue' : field.state)}</dd>
      </div>)}</dl>
    </details>}
    <div className="saas-agent-actions">
      <button disabled={disabled} onClick={() => decide(false)}>{t('approvalCancel')}</button>
      <button className="saas-approve" disabled={disabled || !loaded || failed} onClick={() => decide(true)}>{t('approvalApprove')}</button>
    </div>
  </section>
}
