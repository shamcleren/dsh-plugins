import { useEffect, useState } from 'react'
import type { ReportActions, Run, UiRemote } from '../ui-contract.js'
import { errorKey, type LocaleKey } from './locales.js'
type Props = { id: string; remote: UiRemote; t(key: LocaleKey): string; busy: boolean; runs: Run[]; action(operation: () => Promise<void>): Promise<void>; openSession(id: string): void; showRuns(): void; openReport(id: string): void }
export function ReportFollowUp({ id, remote, t, busy, runs, action, openSession, showRuns, openReport }: Props) {
  const [data, setData] = useState<ReportActions>(), [error, setError] = useState('')
  const [mode, setMode] = useState<'pr' | 'local'>('pr')
  const [selected, setSelected] = useState<string[]>([]), [query, setQuery] = useState('')
  const [category, setCategory] = useState(''), [severity, setSeverity] = useState(''), [status, setStatus] = useState('')
  useEffect(() => {
    let disposed = false
    setData(undefined); setSelected([]); setError(''); setQuery(''); setCategory(''); setSeverity(''); setStatus('')
    void remote.reportActions(id).then(value => { if (!disposed) { setData(value); setMode(value.repairMode) } }).catch(error => { if (!disposed) setError(error instanceof Error ? error.message : 'operation-failed') })
    return () => { disposed = true }
  }, [id, remote])
  if (error) return <div className="alert" role="alert">{t(errorKey(error))}</div>
  if (!data) return <p role="status">{t('loading')}</p>
  const rescan = runs.find(run => run.previousReportId === id)
  const repair = data.run?.repair
  const findings = data.findings.filter(item => item.status !== 'dismissed')
  const visible = findings.filter(item => (item.title + ' ' + item.file).toLowerCase().includes(query.trim().toLowerCase())
    && (!category || item.category === category) && (!severity || item.severity === severity) && (!status || item.status === status))
  const selectedVisible = visible.filter(item => selected.includes(item.id)).length
  const available = visible.filter(item => !selected.includes(item.id))
  const capacity = Math.max(0, 20 - selected.length)
  const addCount = Math.min(capacity, available.length)
  return <section className="card follow-up" aria-label={t('nextSteps')}>
    <div className="card-head"><div className="grow"><h2>{t('nextSteps')}</h2><p className="muted">{t('followUpHint')}</p></div><span className="tag">{findings.length} {t('actionable')}</span></div>
    <div className="follow-up-steps"><div><b>1 · {t('selectFindings')}</b><p className="muted">{t('selectionHint')}</p></div><div><b>2 · {t('repairFindings')}</b><p className="muted">{t('repairHint')}</p></div><div><b>3 · {t('rescan')}</b><p className="muted">{t('rescanHint')}</p></div></div>
    {data.repairable && findings.length ? <details className="finding-picker" open={!!repair || undefined}>
      <summary>{repair ? t('repairStarted') : t('selectFindings')} · {repair ? repair.findingIds.length : selected.length}/20</summary>
      {!repair ? <>
        <input className="search" disabled={busy} aria-label={t('findingSearch')} placeholder={t('findingSearch')} value={query} onChange={event => setQuery(event.target.value)} />
        <div className="finding-filters">
          <label>{t('findingType')}<select aria-label={t('findingType')} disabled={busy} value={category} onChange={event => setCategory(event.target.value)}><option value="">{t('allTypes')}</option>{(['sourceRisk', 'dependencyRisk', 'secretRisk'] as const).map(key => <option key={key} value={key}>{t(key)} ({findings.filter(item => item.category === key).length})</option>)}</select></label>
          <label>{t('riskLevel')}<select aria-label={t('riskLevel')} disabled={busy} value={severity} onChange={event => setSeverity(event.target.value)}><option value="">{t('allLevels')}</option>{(['critical', 'high', 'medium', 'low', 'info'] as const).map(key => <option key={key} value={key}>{t(key)}</option>)}</select></label>
          <label>{t('reviewState')}<select aria-label={t('reviewState')} disabled={busy} value={status} onChange={event => setStatus(event.target.value)}><option value="">{t('allReviewStates')}</option><option value="confirmed">{t('resultConfirmed')}</option><option value="needs-review">{t('resultPending')}</option></select></label>
        </div>
        <div className="actions finding-selection">
          <button disabled={busy || !addCount} onClick={() => setSelected(current => [...new Set([...current, ...available.map(item => item.id)])].slice(0, 20))}>{available.length > capacity ? t('selectFirst') + ' ' + addCount : t('selectVisible')}</button>
          <button disabled={busy || !selectedVisible} onClick={() => setSelected(current => current.filter(key => !visible.some(item => item.id === key)))}>{t('deselectVisible')}</button>
          <button disabled={busy || !selected.length} onClick={() => setSelected([])}>{t('clearSelection')}</button>
          <button disabled={busy || !(query || category || severity || status)} onClick={() => { setQuery(''); setCategory(''); setSeverity(''); setStatus('') }}>{t('resetFilters')}</button>
        </div>
        <p className="muted" role="status">{t('matchingFindings')} {visible.length} · {t('selectedFindings')} {selected.length}/20 · {t('hiddenSelected')} {selected.length - selectedVisible}{selected.length === 20 ? ' · ' + t('selectionLimit') : ''}</p>
      </> : null}
      <div className="finding-list">{(repair ? findings.filter(item => repair.findingIds.includes(item.id)) : visible).map(item => <label key={item.id} className="finding-row"><input type="checkbox" checked={repair ? true : selected.includes(item.id)} disabled={busy || !!repair || (!selected.includes(item.id) && selected.length >= 20)} onChange={event => setSelected(current => event.target.checked ? [...current, item.id] : current.filter(key => key !== item.id))} /><span className="grow"><strong>{item.title}</strong><small>{t(item.category)} · {item.file}:{item.line} · {t(item.status === 'confirmed' ? 'resultConfirmed' : 'resultPending')}</small></span><span className="tag">{t(item.severity)}</span></label>)}{!visible.length && !repair ? <p className="empty">{t('noMatches')}</p> : null}</div>
    </details> : <p className="muted">{findings.length ? t('repairUnavailable') : t('noActionable')}</p>}
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
      {data.repairable && findings.length ? <button className="primary" disabled={busy || (!repair && (!selected.length || (mode === 'pr' && !data.prPreview)))} onClick={() => { void action(async () => {
        const result = await remote.repair(id, repair?.findingIds ?? selected, repair?.mode ?? mode, data.prPreview?.revision)
        setData(await remote.reportActions(id)); openSession(result.sessionId)
      }) }}>{repair ? t(repair.admitted ? 'openRepair' : 'retryRepair') : t(mode === 'pr' ? 'repairPrSelected' : 'repairSelected') + (selected.length ? ' (' + selected.length + ')' : '')}</button> : null}
      {data.run ? <button disabled={busy || runs.some(run => run.taskId === data.run!.taskId && ['queued', 'running', 'cancelling'].includes(run.status))} onClick={() => { void action(async () => { await remote.rescan(id); showRuns() }) }}>{t(repair?.mode === 'pr' || data.run?.repairSource ? 'rescanRepairBranch' : 'rescan')}</button> : <p className="muted">{t('rescanUnavailable')}</p>}
      {rescan ? <button disabled={busy} onClick={() => rescan.reportId ? openReport(rescan.reportId) : showRuns()}>{rescan.reportId ? t('viewComparison') : t('viewProgress')}</button> : null}
    </div>
    {data.comparison ? <details className="comparison" open><summary>{t('comparisonTitle')}</summary><p className="muted">{t(data.comparison.comparable ? 'comparisonHint' : 'comparisonIncomplete')}</p><button disabled={busy} onClick={() => openReport(data.comparison!.previousId)}>{t('previousReport')}</button><div className="comparison-counts">{(['notObserved', 'remaining', 'added', 'unverified'] as const).map(change => <span className="tag" key={change}>{t(change)} · {data.comparison!.items.filter(item => item.change === change).length}</span>)}</div><div className="finding-list">{data.comparison.items.map((item, index) => <div className="finding-row" key={index}><span className="tag">{t(item.change)}</span><span><strong>{item.title}</strong><small>{t(item.category)} · {item.file}:{item.line} · {t(item.status === 'confirmed' ? 'resultConfirmed' : item.status === 'dismissed' ? 'resultDismissed' : 'resultPending')}</small></span></div>)}</div></details> : null}
  </section>
}
