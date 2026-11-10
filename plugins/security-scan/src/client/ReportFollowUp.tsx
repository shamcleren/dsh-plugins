import { useEffect, useState } from 'react'
import type { ReportActions, Run, UiRemote } from '../ui-contract.js'
import { errorKey, type LocaleKey } from './locales.js'
type Item = ReportActions['findings'][number]
/** Runtime findings point at an HTTP endpoint instead of a source line. */
const place = (item: Pick<Item, 'file' | 'line' | 'endpoint'>): string => item.endpoint ?? item.file + ':' + item.line
const steps = ['stepSelect', 'stepRepair', 'stepRescan', 'stepCompare'] as const
const stepHints = ['selectionHint', 'repairHint', 'rescanHint', 'compareHint'] as const
type Props = { id: string; remote: UiRemote; t(key: LocaleKey): string; busy: boolean; runs: Run[]; action(operation: () => Promise<void>): Promise<void>; openSession(id: string): void; showRuns(): void; openReport(id: string): void; notify?(message: string): void }
export function ReportFollowUp({ id, remote, t, busy, runs, action, openSession, showRuns, openReport, notify }: Props) {
  const [data, setData] = useState<ReportActions>(), [error, setError] = useState('')
  const [mode, setMode] = useState<'pr' | 'local'>('pr')
  const [selected, setSelected] = useState<string[]>([]), [query, setQuery] = useState(''), [pickerOpen, setPickerOpen] = useState(false)
  const [category, setCategory] = useState(''), [severity, setSeverity] = useState(''), [status, setStatus] = useState('')
  const [suppressing, setSuppressing] = useState(false), [reason, setReason] = useState('')
  useEffect(() => {
    let disposed = false
    setData(undefined); setSelected([]); setPickerOpen(false); setError(''); setQuery(''); setCategory(''); setSeverity(''); setStatus(''); setSuppressing(false); setReason('')
    void remote.reportActions(id).then(value => { if (!disposed) { setData(value); setMode(value.repairMode) } }).catch(error => { if (!disposed) setError(error instanceof Error ? error.message : 'operation-failed') })
    return () => { disposed = true }
  }, [id, remote])
  // A running repair session can exclude findings or record its PR; follow those changes without a manual refresh.
  const following = !!data?.run?.repair?.admitted
  useEffect(() => {
    if (!following) return
    let disposed = false
    const timer = setInterval(() => {
      void remote.reportActions(id).then(value => {
        if (disposed) return
        setData(value)
        setSelected(current => current.filter(key => value.findings.some(item => item.id === key && item.status !== 'dismissed' && !item.suppressed)))
      }).catch(() => {})
    }, 5000)
    return () => { disposed = true; clearInterval(timer) }
  }, [following, id, remote])
  if (error) return <div className="alert" role="alert">{t(errorKey(error))}</div>
  if (!data) return <p role="status">{t('loading')}</p>
  const rescan = runs.find(run => run.previousReportId === id)
  const repair = data.run?.repair
  // Exclusions saved after this report was written also leave the actionable list immediately.
  const findings = data.findings.filter(item => item.status !== 'dismissed' && !item.suppressed)
  const suppressedCount = data.findings.filter(item => item.suppressed).length
  const selectedItems = findings.filter(item => selected.includes(item.id))
  // A started repair fixes its own selection; the checkboxes then choose only what to exclude.
  const canSuppress = selectedItems.length > 0 && selectedItems.every(item => item.suppressible)
  const inRepair = new Set(repair?.findingIds ?? [])
  const pickable = data.repairable || findings.some(item => item.suppressible)
  const visible = findings.filter(item => (item.title + ' ' + place(item)).toLowerCase().includes(query.trim().toLowerCase())
    && (!category || item.category === category) && (!severity || item.severity === severity) && (!status || item.status === status))
  const selectedVisible = visible.filter(item => selected.includes(item.id)).length
  const available = visible.filter(item => !selected.includes(item.id))
  const capacity = Math.max(0, 20 - selected.length)
  const addCount = Math.min(capacity, available.length)
  const confirmed = findings.filter(item => item.status === 'confirmed'), severe = findings.filter(item => item.severity === 'critical' || item.severity === 'high')
  const addAll = (items: Item[]) => { setPickerOpen(true); setSelected(current => [...new Set([...current, ...items.map(item => item.id)])].slice(0, 20)) }
  // Findings dismissed by review or excluded by the user are not offered for another round.
  const leftover = data.comparison?.items.filter(item => item.change !== 'notObserved' && item.status !== 'dismissed' && !item.suppressed).length ?? 0
  const canContinue = !!data.repairChain && leftover > 0
  // Where the user is in select → repair → rescan → compare; a rescan report is already at the comparison.
  const stage = data.comparison ? 3 : rescan ? (rescan.reportId ? 3 : 2) : repair?.admitted ? 2 : repair || selected.length ? 1 : 0
  const quickSelect = (label: LocaleKey, items: Item[]) => <button disabled={busy || !capacity || items.every(item => selected.includes(item.id))} onClick={() => addAll(items)}>{t(label)} ({items.length})</button>
  return <section className="card follow-up" aria-label={t('nextSteps')}>
    <div className="card-head"><div className="grow"><h2>{t('nextSteps')}</h2><p className="muted">{t('followUpHint')}</p></div><span className="tag">{findings.length} {t('actionable')}</span>{suppressedCount ? <span className="tag">{suppressedCount} {t('suppressedCount')}</span> : null}</div>
    {data.repairable || data.comparison ? <><ol className="stepper">{steps.map((key, index) => <li key={key} className={index < stage ? 'done' : index === stage ? 'current' : ''} aria-current={index === stage ? 'step' : undefined}><span className="step-dot" aria-hidden="true">{index < stage ? '✓' : index + 1}</span>{t(key)}</li>)}</ol>
    <p className="muted step-hint">{t(stepHints[stage]!)}</p></> : null}
    {data.repairable && findings.length && !repair && (confirmed.length || severe.length) ? <div className="quick-select">{confirmed.length ? quickSelect('quickConfirmed', confirmed) : null}{severe.length ? quickSelect('quickHigh', severe) : null}{selected.length ? <span className="muted">{t('selectedFindings')} {selected.length}/20</span> : null}</div> : null}
    {repair ? <p className="muted">{t('repairStarted')} · {repair.findingIds.length} · {t('repairExcludeHint')}</p> : null}
    {pickable && findings.length ? <details className="finding-picker" open={pickerOpen || undefined} onToggle={event => setPickerOpen(event.currentTarget.open)}>
      <summary>{t(repair ? 'selectToExclude' : 'selectFindings')} · {selected.length}/20</summary>
      <>
        <input className="search" disabled={busy} aria-label={t('findingSearch')} placeholder={t('findingSearch')} value={query} onChange={event => setQuery(event.target.value)} />
        <div className="finding-filters">
          <label>{t('findingType')}<select aria-label={t('findingType')} disabled={busy} value={category} onChange={event => setCategory(event.target.value)}><option value="">{t('allTypes')}</option>{(['sourceRisk', 'dependencyRisk', 'secretRisk', 'dynamicRisk'] as const).filter(key => key !== 'dynamicRisk' || findings.some(item => item.category === key)).map(key => <option key={key} value={key}>{t(key)} ({findings.filter(item => item.category === key).length})</option>)}</select></label>
          <label>{t('riskLevel')}<select aria-label={t('riskLevel')} disabled={busy} value={severity} onChange={event => setSeverity(event.target.value)}><option value="">{t('allLevels')}</option>{(['critical', 'high', 'medium', 'low', 'info'] as const).map(key => <option key={key} value={key}>{t(key)}</option>)}</select></label>
          <label>{t('reviewState')}<select aria-label={t('reviewState')} disabled={busy} value={status} onChange={event => setStatus(event.target.value)}><option value="">{t('allReviewStates')}</option><option value="confirmed">{t('resultConfirmed')}</option><option value="needs-review">{t('resultPending')}</option></select></label>
        </div>
        <div className="actions finding-selection">
          <button disabled={busy || !addCount} onClick={() => setSelected(current => [...new Set([...current, ...available.map(item => item.id)])].slice(0, 20))}>{available.length > capacity ? t('selectFirst') + ' ' + addCount : t('selectVisible')}</button>
          <button disabled={busy || !selectedVisible} onClick={() => setSelected(current => current.filter(key => !visible.some(item => item.id === key)))}>{t('deselectVisible')}</button>
          <button disabled={busy || !selected.length} onClick={() => setSelected([])}>{t('clearSelection')}</button>
          <button disabled={busy || !(query || category || severity || status)} onClick={() => { setQuery(''); setCategory(''); setSeverity(''); setStatus('') }}>{t('resetFilters')}</button>
          <button disabled={busy || !canSuppress || suppressing} onClick={() => setSuppressing(true)}>{t('suppressSelected')}{selectedItems.length ? ' (' + selectedItems.length + ')' : ''}</button>
        </div>
        {selectedItems.some(item => !item.suppressible) ? <p className="muted">{t('suppressAiOnly')}</p> : null}
        {suppressing ? <form className="suppress-form" aria-label={t('suppressTitle')} onSubmit={event => { event.preventDefault(); void action(async () => {
          const result = await remote.suppress(id, selectedItems.map(item => item.id), reason.trim())
          setSuppressing(false); setReason(''); setSelected([])
          notify?.(t('suppressDone').replace('{n}', String(result.added + result.existing)))
          setData(await remote.reportActions(id))
        }) }}><strong>{t('suppressTitle')}</strong><p className="muted">{t('suppressHint')}</p>
          <label>{t('suppressReason')}<textarea required maxLength={500} disabled={busy} value={reason} placeholder={t('suppressReasonHint')} onChange={event => setReason(event.target.value)} /></label>
          <div className="actions"><button className="primary" type="submit" disabled={busy || !reason.trim() || !canSuppress}>{t('suppressConfirm')} ({selectedItems.length})</button><button type="button" disabled={busy} onClick={() => { setSuppressing(false); setReason('') }}>{t('cancel')}</button></div>
        </form> : null}
        <p className="muted" role="status">{t('matchingFindings')} {visible.length} · {t('selectedFindings')} {selected.length}/20 · {t('hiddenSelected')} {selected.length - selectedVisible}{selected.length === 20 ? ' · ' + t('selectionLimit') : ''}</p>
      </>
      <div className="finding-list">{visible.map(item => <label key={item.id} className="finding-row"><input type="checkbox" checked={selected.includes(item.id)} disabled={busy || (!selected.includes(item.id) && selected.length >= 20)} onChange={event => setSelected(current => event.target.checked ? [...current, item.id] : current.filter(key => key !== item.id))} /><span className="grow"><strong>{item.title}</strong><small>{t(item.category)} · {place(item)} · {t(item.status === 'confirmed' ? 'resultConfirmed' : 'resultPending')}</small></span>{inRepair.has(item.id) ? <span className="tag ai">{t('inRepair')}</span> : null}<span className="tag">{t(item.severity)}</span></label>)}{!visible.length ? <p className="empty">{t('noMatches')}</p> : null}</div>
    </details> : null}
    {!data.repairable || !findings.length ? <p className="muted">{findings.length ? t('repairUnavailable') : t('noActionable')}</p> : null}
    {data.repairable && findings.length ? <div className="repair-delivery">
      <label>{t('repairDelivery')}<select aria-label={t('repairDelivery')} value={repair?.mode ?? mode} disabled={busy || !!repair} onChange={event => setMode(event.target.value as 'pr' | 'local')}><option value="pr">{t('deliveryPr')}</option><option value="local">{t('deliveryLocal')}</option></select></label>
      <p className="muted">{t((repair?.mode ?? mode) === 'pr' ? 'deliveryPrHint' : 'deliveryLocalHint')}</p>
      {(repair?.mode ?? mode) === 'pr' ? <>
        {repair?.workspace ? <p className="muted">{repair.workspace.repositoryUrl || t('noRepairRemote')}<br />{t('prBase')}: {repair.workspace.base} · {repair.workspace.commit.slice(0, 12)}<br />{t('prBranch')}: {repair.workspace.branch}</p> : data.prPreview ? <p className="muted">{data.prPreview.repositoryUrl || t('noRepairRemote')}<br />{t('prBase')}: {data.prPreview.base} · {data.prPreview.commit.slice(0, 12)}</p> : <p role="alert">{t(errorKey(data.prError ?? 'repair-pr-repository'))}</p>}
        {repair?.workspace?.prUrl ? <a href={repair.workspace.prUrl} target="_blank" rel="noopener noreferrer">{t('viewRepairPr')}</a> : repair ? <p className="muted">{t('prPending')}</p> : null}
        <button disabled={busy} onClick={() => { void action(async () => setData(await remote.reportActions(id))) }}>{t('refreshDelivery')}</button>
      </> : null}
    </div> : null}
    {data.run?.repairSource ? <p className="muted">{t('rescanRepairBranch')}: {data.run.repairSource.branch}{data.run.repairSource.prUrl ? <> · <a href={data.run.repairSource.prUrl} target="_blank" rel="noopener noreferrer">{t('viewRepairPr')}</a></> : null}</p> : null}
    <div className="actions">
      {canContinue ? <button className="primary" disabled={busy} onClick={() => { void action(async () => { const result = await remote.continueRepair(id); openSession(result.sessionId) }) }}>{t('continueRepair')} · {t('repairRound').replace('{n}', String(data.repairChain!.round))}</button> : null}
      {data.repairable && findings.length ? <button className={canContinue ? '' : 'primary'} disabled={busy || (!repair && (!selected.length || (mode === 'pr' && !data.prPreview)))} onClick={() => { void action(async () => {
        const result = await remote.repair(id, repair?.findingIds ?? selected, repair?.mode ?? mode, data.prPreview?.revision)
        setData(await remote.reportActions(id)); openSession(result.sessionId)
      }) }}>{repair ? t(repair.admitted ? 'openRepair' : 'retryRepair') : t(mode === 'pr' ? 'repairPrSelected' : 'repairSelected') + (selected.length ? ' (' + selected.length + ')' : '')}</button> : null}
      {data.run ? <button disabled={busy || runs.some(run => run.taskId === data.run!.taskId && ['queued', 'running', 'cancelling'].includes(run.status))} onClick={() => { void action(async () => { await remote.rescan(id); showRuns() }) }}>{t(repair?.mode === 'pr' || data.run?.repairSource ? 'rescanRepairBranch' : 'rescan')}</button> : <p className="muted">{t('rescanUnavailable')}</p>}
      {rescan ? <button disabled={busy} onClick={() => rescan.reportId ? openReport(rescan.reportId) : showRuns()}>{rescan.reportId ? t('viewComparison') : t('viewProgress')}</button> : null}
    </div>
    {data.comparison ? <details className="comparison" open><summary>{t('comparisonTitle')}</summary><p className="muted">{t(data.comparison.comparable ? 'comparisonHint' : 'comparisonIncomplete')}</p><button disabled={busy} onClick={() => openReport(data.comparison!.previousId)}>{t('previousReport')}</button><div className="comparison-counts">{(['notObserved', 'remaining', 'added', 'unverified'] as const).map(change => <span className="tag" key={change}>{t(change)} · {data.comparison!.items.filter(item => item.change === change).length}</span>)}</div><div className="finding-list">{data.comparison.items.map((item, index) => <div className="finding-row" key={index}><span className="tag">{t(item.change)}</span><span><strong>{item.title}</strong><small>{t(item.category)} · {place(item)} · {t(item.status === 'confirmed' ? 'resultConfirmed' : item.status === 'dismissed' ? 'resultDismissed' : 'resultPending')}</small></span></div>)}</div></details> : null}
  </section>
}
