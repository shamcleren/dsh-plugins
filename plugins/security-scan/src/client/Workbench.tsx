import { ModelPicker } from './ModelPicker.js'
import { useCallback, useEffect, useRef, useState, type ReactNode, type FormEvent } from 'react'
import { newTask, type TaskConfig, type Task, type Run, type ScanSettings, type UiRemote, type UiState, type ReportItem } from '../ui-contract.js'
import { formatAgentUsage } from '../agent-contract.js'
import { errorKey, enginePhaseKey, engineErrorKey, agentReasonKey, type LocaleKey } from './locales.js'
import { css } from './styles.js'
type Translate = (key: LocaleKey) => string
type Editor = { id?: string; revision?: number; config: TaskConfig }
const isActive = (run: Run): boolean => ['queued', 'running', 'cancelling'].includes(run.status)
const phaseKey = (phase: Run['phase']): LocaleKey => phase === 'baseline' ? 'baselinePhase' : phase === 'report' ? 'reportPhase' : phase
const date = (value: string): string => new Date(value).toLocaleString()
const usageLine = (audit: Parameters<typeof formatAgentUsage>[0] | undefined, t: Translate): string => audit ? formatAgentUsage(audit, t('cacheHit')) ?? '' : ''
const reportMeta = (item: ReportItem, t: Translate): string => [date(item.createdAt), item.findings + ' ' + t('countSuffix'), item.agent?.model, usageLine(item.agent, t)].filter(Boolean).join(' · ')
function Field({ label, hint, children, wide = false }: { label: string; hint?: string; children: ReactNode; wide?: boolean }) {
  return <label className={'field' + (wide ? ' span' : '')}><span>{label}</span>{children}{hint ? <span className="muted">{hint}</span> : null}</label>
}
function Check({ label, hint, value, onChange }: { label: string; hint: string; value: boolean; onChange(value: boolean): void }) {
  return <label className="check"><input type="checkbox" checked={value} onChange={event => onChange(event.target.checked)} /><span>{label}<p className="muted">{hint}</p></span></label>
}
export function Workbench({ remote, t, close, openSession, requestedReport }: { remote: UiRemote; requestedReport?: string; t: Translate; close(): void; openSession(id: string): void }) {
  const [tab, setTab] = useState<'tasks' | 'runs' | 'reports' | 'settings'>('tasks')
  const [state, setState] = useState<UiState>()
  const [editor, setEditor] = useState<Editor>()
  const [settings, setSettings] = useState<ScanSettings>()
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [notice, setNotice] = useState('')
  const [confirm, setConfirm] = useState<{ kind: 'remove' | 'hook'; task: Task } | { kind: 'removeRun' | 'removeReport'; id: string; name: string; detail: string }>()
  const [hookEvent, setHookEvent] = useState<'pre-commit' | 'pre-push'>('pre-commit')
  const [hookAction, setHookAction] = useState<'install' | 'remove'>('install'), [enforce, setEnforce] = useState(false)
  const [hookBase, setHookBase] = useState('')
  const [report, setReport] = useState<{ id: string; html: string }>()
  const frame = useRef<HTMLIFrameElement>(null)
  const [source, setSource] = useState<{ file: string; line: number; content: string }>()
  const [search, setSearch] = useState('')
  const [taskSearch, setTaskSearch] = useState('')
  const generation = useRef(0)
  const alive = useRef(true), panel = useRef<HTMLDivElement>(null), form = useRef<HTMLFormElement>(null)
  const urls = useRef(new Set<string>())
  const reload = useCallback(async () => {
    const current = ++generation.current
    const next = await remote.state()
    if (alive.current && current === generation.current) { setState(next); setSettings(current => current ?? next.settings) }
  }, [remote])
  useEffect(() => {
    alive.current = true
    const previous = document.activeElement
    const keepFocus = (event: FocusEvent) => { if (event.target instanceof Node && panel.current && !panel.current.contains(event.target)) panel.current.querySelector<HTMLElement>('button:not(:disabled),input:not(:disabled)')?.focus() }
    document.addEventListener('focusin', keepFocus)
    panel.current?.querySelector<HTMLButtonElement>('button')?.focus()
    let timer: ReturnType<typeof setTimeout> | undefined
    const poll = async () => {
      try { await reload() } catch (error) { if (alive.current) setError(error instanceof Error ? error.message : 'operation-failed') }
      if (alive.current) timer = setTimeout(() => { void poll() }, 2000)
    }
    void poll()
    return () => { document.removeEventListener('focusin', keepFocus); alive.current = false; clearTimeout(timer); for (const url of urls.current) URL.revokeObjectURL(url); if (previous instanceof HTMLElement) previous.focus() }
  }, [reload])
  useEffect(() => {
    setSource(undefined)
    let current = 0, disposed = false
    const receive = (event: MessageEvent) => {
      const data = event.data
      if (event.source !== frame.current?.contentWindow || !report || data?.type !== 'dsh-security-source' || data.reportId !== report.id || typeof data.file !== 'string' || !Number.isSafeInteger(data.line) || data.line < 1) return
      const request = ++current
      void remote.source(report.id, data.file, data.line).then(result => {
        if (!disposed && request === current) setSource({ file: data.file, line: data.line, content: result.content })
      }).catch(() => { if (!disposed && request === current) setError('source-unavailable') })
    }
    window.addEventListener('message', receive)
    return () => { disposed = true; window.removeEventListener('message', receive) }
  }, [report, remote])
  useEffect(() => {
    if (!requestedReport) return
    let disposed = false
    void remote.report(requestedReport, 'html').then(html => { if (!disposed) setReport({ id: requestedReport, html }) }).catch(() => { if (!disposed) setError('report-directory-unavailable') })
    return () => { disposed = true }
  }, [requestedReport, remote])
  const viewKey = report?.id ?? (confirm ? confirm.kind + ('task' in confirm ? confirm.task.id : confirm.id) : editor ? 'editor-' + (editor.id ?? 'new') : tab)
  useEffect(() => {
    if (!busy && panel.current && (!document.activeElement || !panel.current.contains(document.activeElement))) panel.current.querySelector<HTMLElement>('main input:not(:disabled),main select:not(:disabled),main button:not(:disabled),button')?.focus()
  }, [viewKey, busy])
  const action = async (operation: () => Promise<void>) => {
    if (busy) return
    setBusy(true); setError(''); setNotice('')
    try { await operation(); await reload() } catch (error) { if (alive.current) setError(error instanceof Error ? error.message : 'operation-failed') }
    finally { if (alive.current) setBusy(false) }
  }
  const openReport = (id: string) => action(async () => { const html = await remote.report(id, 'html'); if (alive.current) setReport({ id, html }) })
  const download = (format: 'html' | 'json') => action(async () => {
    if (!report) return
    const content = await remote.report(report.id, format)
    if (!alive.current) return
    const url = URL.createObjectURL(new Blob([content], { type: format === 'html' ? 'text/html;charset=utf-8' : 'application/json' })); urls.current.add(url)
    const link = document.createElement('a'); link.href = url; link.download = 'security-' + report.id + '.' + format; link.click()
  })
  const save = (run: boolean) => {
    if (!editor || !form.current?.reportValidity()) return
    return action(async () => {
      const task = await remote.save(editor.config, editor.id, editor.revision)
      if (!alive.current) return
      setEditor({ id: task.id, revision: task.revision, config: task.config })
      if (run) { await remote.run(task.id, task.revision); setTab('runs') }
      setEditor(undefined); setNotice(t('taskSaved'))
    })
  }
  const change = <K extends keyof TaskConfig>(key: K, value: TaskConfig[K]): void => setEditor(current => current ? { ...current, config: { ...current.config, [key]: value } } : current)
  const scopeChange = (scope: TaskConfig['scope']): void => setEditor(current => current ? { ...current, config: { ...current.config, scope,
    ...(scope === 'diff' ? { baseline: 'git' as const } : {}), ...(scope === 'staged' ? { baseline: 'none' as const, base: '', baselineId: '', ref: '', autoScan: false } : {}) } } : current)
  const config = editor?.config
  const reportChoices = [...new Map([...(state?.reports ?? []).map(item => [item.id, item.source + ' · ' + date(item.createdAt)] as const), ...(state?.runs ?? []).flatMap(item => item.reportId ? [[item.reportId, item.config.name + ' · ' + date(item.createdAt)] as const] : [])]).entries()]
  const renderEditor = () => config && <form ref={form} className="card editor" onSubmit={(event: FormEvent) => { event.preventDefault(); void save(false) }}>
    <h2>{editor?.id ? t('edit') : t('newTask')}</h2><fieldset disabled={busy}><div className="grid"><h3 className="section-title span">{t('sourceSection')}</h3>
      <Field label={t('name')} wide><input required maxLength={100} value={config.name} onChange={event => change('name', event.target.value)} /></Field>
      <Field label={t('kind')}><select value={config.kind} onChange={event => setEditor(current => current ? { ...current, config: { ...current.config, kind: event.target.value as TaskConfig['kind'], target: '', ref: '', scope: 'full', baseline: 'none', base: '', baselineId: '', autoScan: false } } : current)}><option value="local">{t('local')}</option><option value="remote">{t('remote')}</option></select></Field>
      <Field label={t('scope')}><select value={config.scope} onChange={event => scopeChange(event.target.value as TaskConfig['scope'])}><option value="full">{t('full')}</option><option value="diff">{t('diff')}</option>{config.kind === 'local' ? <option value="staged">{t('staged')}</option> : null}</select></Field>
      <Field label={t('target')} hint={t(config.kind === 'local' ? 'localHint' : 'remoteHint')} wide><input required value={config.target} onChange={event => change('target', event.target.value)} placeholder={config.kind === 'local' ? '/path/to/project' : 'https://git.example.com/team/project.git'} /></Field>
      <h3 className="section-title span">{t('policySection')}</h3>{config.scope !== 'staged' ? <Field label={t('ref')} hint={t('refHint')} wide><input value={config.ref} onChange={event => { change('ref', event.target.value); if (event.target.value) change('autoScan', false) }} /></Field> : <p className="muted span">{t('stagedHint')}</p>}
      {config.scope !== 'staged' ? <><Field label={t('baseline')}><select value={config.baseline} onChange={event => change('baseline', event.target.value as TaskConfig['baseline'])} disabled={config.scope === 'diff'}><option value="none">{t('none')}</option><option value="git">{t('git')}</option><option value="report">{t('report')}</option></select></Field>
        {config.baseline === 'git' ? <Field label={t('base')} hint={t('baseHint')}><input required value={config.base} onChange={event => change('base', event.target.value)} placeholder="origin/main" /></Field> : null}
        {config.baseline === 'report' ? <Field label={t('baselineId')}><select required value={config.baselineId} onChange={event => change('baselineId', event.target.value)}><option value="">{t('selectReport')}</option>{reportChoices.map(([id, label]) => <option key={id} value={id}>{label}</option>)}</select></Field> : null}</> : null}
      <Field label={t('engine')}><select value={config.engine} onChange={event => change('engine', event.target.value as TaskConfig['engine'])}><option value="auto">{t('auto')}</option><option value="inventory">{t('inventory')}</option></select></Field>
      <Field label={t('view')}><select value={config.view} onChange={event => change('view', event.target.value as TaskConfig['view'])}><option value="all">{t('all')}</option><option value="new">{t('new')}</option></select></Field>
    </div><section className="agent-policy"><Check label={t('agentEnable')} hint={t('agentHint')} value={config.agent.enabled} onChange={enabled => change('agent', { ...config.agent, enabled })} />
      {config.agent.enabled ? <><p><strong>{t('agentPreset')}</strong></p><p className="muted">{t('agentPresetHint')}</p><p className="flow">{t('flow')}</p><ModelPicker remote={remote} value={config.agent} defaultModel={state?.agentDefault ?? null} t={t} onChange={selection => change('agent', { ...config.agent, ...selection })} /><p className="muted">{t('agentBudget')}</p></> : null}</section><Check label={t('dependencies')} hint={t('dependenciesHint')} value={config.dependencies} onChange={value => change('dependencies', value)} />
      <Check label={t('secrets')} hint={t('secretsHint')} value={config.secrets} onChange={value => change('secrets', value)} />
      {config.kind === 'local' && config.scope !== 'staged' && !config.ref ? <Check label={t('autoScan')} hint={t('autoHint')} value={config.autoScan} onChange={value => change('autoScan', value)} /> : null}
      <Check label={t('syncSession')} hint={t('syncSessionHint')} value={config.syncSession} onChange={value => change('syncSession', value)} /><div className="form-footer"><button className="primary" type="button" onClick={() => { void save(true) }}>{t('saveRun')}</button><button type="submit">{t('save')}</button><button type="button" onClick={() => setEditor(undefined)}>{t('cancel')}</button></div>
    </fieldset></form>
  const renderTasks = () => <><div className="toolbar"><div className="grow"><h2>{t('tasks')}</h2><p className="muted">{t('taskIntro')}</p></div><input className="search" aria-label={t('taskSearch')} placeholder={t('taskSearch')} value={taskSearch} onChange={event => setTaskSearch(event.target.value)} /><button className="primary" disabled={busy} onClick={() => setEditor({ config: newTask() })}>＋ {t('newTask')}</button></div>
    {!state?.tasks.length ? <div className="empty"><h3>{t('emptyTasks')}</h3><p className="muted">{t('emptyTasksHint')}</p></div> : <div className="cards">{state.tasks.filter(task => (task.config.name + ' ' + task.config.target).toLowerCase().includes(taskSearch.toLowerCase())).map(task => {
      const running = state.runs.find(run => run.taskId === task.id && isActive(run)), latest = state.runs.find(run => run.taskId === task.id)
      return <article className="card" key={task.id}><div className="card-head"><div className="grow"><h3>{task.config.name}</h3><p className="muted">{task.config.target}</p></div>{latest ? <span className={'tag ' + latest.status}>{t(latest.status)}</span> : null}</div>
        <div className="tags">{task.config.agent.enabled ? <span className="tag ai">Agentic AI</span> : null}<span className="tag">{t(task.config.kind)}</span><span className="tag">{t(task.config.scope)}</span><span className="tag">{t(task.config.engine)}</span><span className="tag">{task.config.baseline === 'none' ? t('noBaseline') : task.config.base || task.config.baselineId}</span>{task.config.autoScan ? <span className="tag">{t('autoLabel')}</span> : null}</div>
        <div className="actions"><button className="primary" disabled={busy || !!running} onClick={() => { void action(async () => { await remote.run(task.id, task.revision); setTab('runs') }) }}>{t('run')}</button>
          <button disabled={busy} onClick={() => setEditor({ id: task.id, revision: task.revision, config: { ...task.config } })}>{t('edit')}</button>
          <button disabled={busy} onClick={() => setEditor({ config: { ...structuredClone(task.config), name: task.config.name.slice(0, 90) + ' ' + t('copySuffix') } })}>{t('duplicate')}</button>
          {latest?.reportId ? <button disabled={busy} onClick={() => { void openReport(latest.reportId!) }}>{t('openReport')}</button> : null}
          {task.config.kind === 'local' ? <button disabled={busy || !!running} onClick={() => { setConfirm({ kind: 'hook', task }); setHookBase(task.config.base); setHookEvent('pre-commit'); setHookAction('install'); setEnforce(false) }}>{t('hook')}</button> : null}
          <button className="danger" disabled={busy || !!running} onClick={() => setConfirm({ kind: 'remove', task })}>{t('remove')}</button></div></article>
    })}</div>}{state?.tasks.length && !state.tasks.some(task => (task.config.name + ' ' + task.config.target).toLowerCase().includes(taskSearch.toLowerCase())) ? <p className="empty">{t('noTaskMatch')}</p> : null}<p className="muted">{t('rulesHint')}</p></>
  const renderRuns = () => <><h2>{t('runs')}</h2>{!state?.runs.length ? <div className="empty">{t('emptyRuns')}</div> : <div className="card table-wrap"><table><thead><tr><th>{t('taskName')}</th><th>{t('createdAt')}</th><th>{t('status')}</th><th>{t('actions')}</th></tr></thead><tbody>{state.runs.map(run => <tr key={run.id}><td><strong>{run.config.name}</strong><p className="muted">{t(run.config.scope)} · {t(run.config.engine)} · {t(run.trigger === 'edit' ? 'editTrigger' : run.trigger === 'conversation' ? 'conversationTrigger' : 'manual')}</p></td><td>{date(run.createdAt)}</td><td><span className={'tag ' + run.status}>{t(run.status)}</span><p className="muted">{t(phaseKey(run.phase))}{run.findings === undefined ? '' : ' · ' + run.findings + ' ' + t('countSuffix')}</p>{!isActive(run) && (run.coverage === 'partial' || run.status === 'partial') ? <p className="coverage-notice">{t('coveragePartial')}</p> : null}{run.resultSummary ? <p>{t('resultConfirmed')}: {run.resultSummary.confirmed} · {t('resultPending')}: {run.resultSummary.pending} · {t('resultDismissed')}: {run.resultSummary.dismissed}</p> : null}{run.agent && !isActive(run) ? <p>{run.agent.nativeEnd === 'completed' || (!run.agent.nativeEnd && run.agent.status === 'completed') ? t('nativeCompleted') : t('nativeStopped')}{run.agent.nativeEnd ? ' · ' + run.agent.nativeEnd : ''}</p> : null}{run.agent ? <details className="agent-trace"><summary>{t('agentDetails')} · {run.agent.steps} {t('agentRounds')}</summary><p>{[run.agent.provider, run.agent.model].filter(Boolean).join('/')}{usageLine(run.agent, t) ? ' · ' + usageLine(run.agent, t) : ''}</p><p>{t('agentFiles')}: {run.agent.files.length} · {t('agentReviewed')}: {run.agent.reviewedFindings}/{run.agent.eligibleCandidates ?? '—'} · {t('agentAdditional')}: {run.agent.additionalFindings}</p>{!isActive(run) ? <p>{run.agent.status === 'completed' ? t('agentCompleted') : t('agentIncomplete') + ' · ' + t(agentReasonKey(run.agent.reason))}</p> : null}<ol>{run.agent.events.map((event, index) => <li key={index}><b>{event.step}</b> {t(event.kind)}{event.files.length ? ' · ' + event.files.join(', ') : ''}{event.count ? ' · ' + event.count : ''}{event.code ? <p className="error">{t(errorKey(event.code))}</p> : null}</li>)}</ol></details> : null}{run.diagnostics?.length ? <details className="agent-trace"><summary>{t('coverageDetails')}</summary>{run.diagnostics.map((detail, index) => <p key={index}>{detail}</p>)}</details> : null}{run.sessionWarning ? <p className="error">{t('sessionUnavailable')}</p> : null}{run.error && run.error !== 'cancelled' ? <p className="muted">{t(errorKey(run.error))}</p> : null}</td><td><div className="row-actions">{run.sessionId ? <button disabled={busy} onClick={() => { void action(async () => openSession(run.sessionId!)) }}>{t('openSession')}</button> : null}{isActive(run) ? <button disabled={busy || run.status === 'cancelling'} onClick={() => { void action(() => remote.cancel(run.id)) }}>{t('cancel')}</button> : null}{run.rulesReportId && run.reportId !== run.rulesReportId ? <button disabled={busy} onClick={() => { void openReport(run.rulesReportId!) }}>{t('rulesReport')}</button> : null}{!isActive(run) ? <button className="danger" disabled={busy} onClick={() => setConfirm({ kind: 'removeRun', id: run.id, name: run.config.name, detail: date(run.createdAt) })}>{t('deleteRun')}</button> : null}{run.reportId ? <button disabled={busy} onClick={() => { void openReport(run.reportId!) }}>{t('openReport')}</button> : null}</div></td></tr>)}</tbody></table></div>}</>
  const renderReports = () => <><div className="toolbar"><h2>{t('reports')}</h2><input className="search" aria-label={t('source')} placeholder={t('source')} value={search} onChange={event => setSearch(event.target.value)} /></div><p className="muted">{t('reportHint')}</p><div className="cards">{state?.reports.filter(item => item.source.toLowerCase().includes(search.toLowerCase())).map(item => <article className="card" key={item.id}><h3>{item.source}</h3><p className="muted">{reportMeta(item, t)}</p><code>{item.id}</code><div className="actions"><button disabled={busy} onClick={() => { void openReport(item.id) }}>{t('openReport')}</button><button className="danger" disabled={busy} onClick={() => setConfirm({ kind: 'removeReport', id: item.id, name: item.source, detail: date(item.createdAt) + ' · ' + item.id })}>{t('deleteReport')}</button></div></article>)}</div>{!state?.reports.length ? <div className="empty">{t('emptyReports')}</div> : null}</>
  const renderEngines = () => <section className="card engine-panel" aria-label={t('enginesTitle')}><div className="card-head"><div className="grow"><h3>{t('enginesTitle')}</h3><p className="muted">{t('scannerHint')}</p></div><span className={'tag ' + (state?.toolchains?.status === 'ready' ? 'succeeded' : '')}>{t(state?.toolchains?.status === 'ready' ? 'engineReady' : state?.toolchains?.status === 'installing' ? 'engineInstalling' : state?.toolchains?.status === 'failed' ? 'engineFailed' : 'engineIdle')}</span></div>
    <div className="engine-grid">{(['semgrep', 'gitleaks'] as const).map(engine => <div className="engine-item" key={engine}><span className="engine-symbol" aria-hidden="true">{engine === 'semgrep' ? '⌘' : '◇'}</span><div className="grow"><strong>{engine === 'semgrep' ? 'Semgrep' : 'Gitleaks'}</strong><p className="muted">{t(engine === 'semgrep' ? 'semgrepPurpose' : 'gitleaksPurpose')}</p></div><code>{state?.toolchains?.[engine] ?? '—'}</code></div>)}</div>
    {state?.toolchains?.status === 'installing' ? <p className="engine-progress" role="status"><span className="spinner" aria-hidden="true" />{t(enginePhaseKey(state.toolchains.phase))}</p> : null}
    {state?.toolchains?.status === 'failed' ? <p className="error" role="alert">{t(engineErrorKey(state.toolchains.error))}</p> : null}
    {state?.toolchains?.status === 'failed' || state?.toolchains?.status === 'idle' ? <button disabled={busy} onClick={() => { void action(() => remote.setup()) }}>{t('engineRetry')}</button> : null}
  </section>
  const renderSettings = () => settings && <>{renderEngines()}<form className="card editor" onSubmit={event => { event.preventDefault(); void action(async () => { await remote.settings({ ...settings, hookTools: settings.hookTools.map(value => value.trim()).filter(Boolean) }); setNotice(t('settingsSaved')) }) }}><h2>{t('settings')}</h2>{!state?.settingsWritable ? <p className="alert">{t('readOnly')}</p> : null}<fieldset disabled={busy || !state?.settingsWritable}><div className="grid">
    <Field label={t('reportDirectory')} wide><input required value={settings.reportDirectory} onChange={event => setSettings({ ...settings, reportDirectory: event.target.value })} /></Field></div>
    <details className="advanced"><summary>{t('engineOverrides')}</summary><p className="muted">{t('overrideHint')}</p><div className="grid">
    <Field label={t('semgrepPath')}><input value={settings.semgrepPath === 'semgrep' ? '' : settings.semgrepPath} placeholder={t('managedDefault')} onChange={event => setSettings({ ...settings, semgrepPath: event.target.value || 'semgrep' })} /></Field>
    <Field label={t('gitleaksPath')}><input value={settings.gitleaksPath === 'gitleaks' ? '' : settings.gitleaksPath} placeholder={t('managedDefault')} onChange={event => setSettings({ ...settings, gitleaksPath: event.target.value || 'gitleaks' })} /></Field>
    <Field label={t('hookTools')} hint={t('hookToolsHint')} wide><textarea value={settings.hookTools.join('\n')} onChange={event => setSettings({ ...settings, hookTools: event.target.value.split('\n') })} /></Field>
    </div><Check label={t('legacyAuto')} hint={t('legacyHint')} value={settings.autoScan} onChange={value => setSettings({ ...settings, autoScan: value })} /></details><div className="form-footer"><button className="primary" type="submit">{t('saveSettings')}</button></div></fieldset></form></>
  const renderConfirm = () => confirm && !('task' in confirm) ? <section className="card confirm-box" role="alertdialog" aria-label={t(confirm.kind === 'removeRun' ? 'deleteRun' : 'deleteReport')}>
    <h2>{t(confirm.kind === 'removeRun' ? 'deleteRun' : 'deleteReport')}</h2><strong>{confirm.name}</strong><p>{confirm.detail}</p>
    <p className="muted">{t(confirm.kind === 'removeRun' ? 'deleteRunHint' : 'deleteReportHint')}</p>
    <div className="form-footer"><button className="danger" disabled={busy} onClick={() => { void action(async () => {
      if (confirm.kind === 'removeRun') await remote.removeRun(confirm.id); else await remote.removeReport(confirm.id)
      setConfirm(undefined); setNotice(t('deleted'))
    }) }}>{t('confirmDelete')}</button><button disabled={busy} onClick={() => setConfirm(undefined)}>{t('cancel')}</button></div>
  </section> : confirm && 'task' in confirm && <section className="card confirm-box" role="alertdialog" aria-label={t(confirm.kind === 'hook' ? 'hookTitle' : 'removeTitle')}><h2>{t(confirm.kind === 'hook' ? 'hookTitle' : 'removeTitle')}</h2><strong>{confirm.task.config.name}</strong><p>{confirm.task.config.target}</p><p className="muted">{t(confirm.kind === 'hook' ? 'hookHint' : 'removeHint')}</p>
    {confirm.kind === 'hook' ? <fieldset disabled={busy}><div className="grid"><Field label={t('hookEvent')}><select value={hookEvent} onChange={event => setHookEvent(event.target.value as typeof hookEvent)}><option value="pre-commit">{t('preCommit')}</option><option value="pre-push">{t('prePush')}</option></select></Field><Field label={t('actions')}><select value={hookAction} onChange={event => setHookAction(event.target.value as typeof hookAction)}><option value="install">{t('hookInstall')}</option><option value="remove">{t('hookRemove')}</option></select></Field>{hookEvent === 'pre-push' && hookAction === 'install' ? <Field label={t('base')} wide><input value={hookBase} onChange={event => setHookBase(event.target.value)} placeholder="origin/main" /></Field> : null}</div><Check label={t('enforce')} hint={t('enforceHint')} value={enforce} onChange={setEnforce} /></fieldset> : null}
    <div className="form-footer"><button disabled={busy || (confirm.kind === 'hook' && hookEvent === 'pre-push' && hookAction === 'install' && !hookBase.trim())} className="primary" onClick={() => { void action(async () => { if (confirm.kind === 'remove') await remote.remove(confirm.task.id, confirm.task.revision); else await remote.hook({ taskId: confirm.task.id, revision: confirm.task.revision, event: hookEvent, action: hookAction, enforce, base: hookBase, confirm: true }); setConfirm(undefined); setNotice(t(confirm.kind === 'hook' ? 'hookDone' : 'taskSaved')) }) }}>{t(confirm.kind === 'hook' ? 'hookConfirm' : 'confirm')}</button><button disabled={busy} onClick={() => setConfirm(undefined)}>{t('cancel')}</button></div></section>
  return <div className="security-workbench" role="dialog" aria-modal="true" aria-label={t('title')} ref={panel} onKeyDown={event => {
    if (event.key === 'Escape') { if (source) setSource(undefined); else if (report) setReport(undefined); else if (confirm) setConfirm(undefined); else if (editor) setEditor(undefined); else close() }
    if (event.key === 'Tab') { const focusable = [...(panel.current?.querySelectorAll<HTMLElement>('button:not(:disabled),input:not(:disabled),select:not(:disabled),textarea:not(:disabled),iframe') ?? [])]; const first = focusable[0], last = focusable.at(-1); if (event.shiftKey && document.activeElement === first) { last?.focus(); event.preventDefault() } else if (!event.shiftKey && document.activeElement === last) { first?.focus(); event.preventDefault() } }
  }}><style>{css}</style><header><button onClick={close}>← {t('back')}</button><div className="grow"><h1>{t('title')}</h1><p className="muted">{t('subtitle')}</p></div><button disabled={busy} onClick={() => { void action(reload) }}>{t('refresh')}</button></header><div className="body"><nav aria-label={t('title')}>{(['tasks', 'runs', 'reports', 'settings'] as const).map(value => <button key={value} className={tab === value ? 'selected' : ''} aria-current={tab === value ? 'page' : undefined} onClick={() => { setTab(value); setEditor(undefined); setConfirm(undefined); setReport(undefined) }}>{t(value)}{state && value !== 'settings' ? <span className="nav-count">{state[value].length}</span> : null}</button>)}</nav><main><div className={report ? 'content report-content' : 'content'}>
    {state?.toolchains && state.toolchains.status !== 'ready' && tab !== 'settings' && !report ? <div className="environment-banner" role="status"><span>{t(state.toolchains.status === 'failed' ? 'engineFailed' : 'engineInstalling')} · {t(state.toolchains.status === 'failed' ? engineErrorKey(state.toolchains.error) : enginePhaseKey(state.toolchains.phase))}</span><button onClick={() => { setTab('settings'); setEditor(undefined); setConfirm(undefined) }}>{t('viewEnvironment')}</button></div> : null}
    {state?.warnings.map(warning => <div className="alert" key={warning}>{t(errorKey(warning))}</div>)}
    {error ? <div className="alert error" role="alert">{t(errorKey(error))}</div> : null}{notice ? <div className="alert notice" role="status">{notice}</div> : null}
    {!state ? <p>{t('loading')}</p> : report ? <><div className="toolbar"><button onClick={() => setReport(undefined)}>← {t('closeReport')}</button><div className="row-actions"><button disabled={busy} onClick={() => { void download('html') }}>{t('downloadHtml')}</button><button disabled={busy} onClick={() => { void download('json') }}>{t('downloadJson')}</button></div></div><p className="muted">{t('reportHint')} <code>{report.id}</code></p>{source ? <section className="source-preview" role="region" aria-label={t('sourcePreview')}><div className="toolbar"><strong>{source.file}:{source.line}</strong><button onClick={() => setSource(undefined)}>{t('closeSource')}</button></div><pre>{source.content.split('\n').map((line, index) => <span key={index} className={line.startsWith(source.line + ':') ? 'source-highlight' : ''}>{line}{'\n'}</span>)}</pre></section> : null}<iframe ref={frame} title={t('openReport')} srcDoc={report.html} sandbox="allow-scripts allow-modals allow-popups allow-popups-to-escape-sandbox" /></> : confirm ? renderConfirm() : editor ? renderEditor() : tab === 'tasks' ? renderTasks() : tab === 'runs' ? renderRuns() : tab === 'reports' ? renderReports() : renderSettings()}
  </div></main></div></div>
}
