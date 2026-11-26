import { useEffect, useRef, useState } from 'react'
import { errorCodes, type Activity, type Encryption, type Owner, type Preview, type Project, type ProjectStatus, type Remote, type Repository, type State, type Task } from '../types.js'
import type { LocaleKey } from './locales.js'
export { styles } from './styles.js'

type Translate = (key: LocaleKey) => string
const active = (task: Task) => task.status === 'running' || task.status === 'cancelling'
const ownerKey = (owner: Owner) => owner.kind + ':' + owner.login

export function Panel({ remote, t }: { remote: Remote; t: Translate }) {
  const [state, setState] = useState<State>(), [owners, setOwners] = useState<Owner[]>([]), [owner, setOwner] = useState<Owner>()
  const [repositories, setRepositories] = useState<Repository[]>([]), [query, setQuery] = useState(''), [page, setPage] = useState(0), [more, setMore] = useState(false)
  const [catalogLoading, setCatalogLoading] = useState(false), [pending, setPending] = useState<string[]>([])
  const [chosen, setChosen] = useState(''), [status, setStatus] = useState<ProjectStatus>(), [selected, setSelected] = useState<string[]>([])
  const [preview, setPreview] = useState<Preview>(), [message, setMessage] = useState(''), [tab, setTab] = useState<'overview' | 'changes'>('overview')
  const [activity, setActivity] = useState<Activity>({ projects: [], tasks: [], login: null, tools: { status: 'checking' } }), [visibleFiles, setVisibleFiles] = useState(100)
  const [notice, setNotice] = useState(''), [error, setError] = useState('')
  const mounted = useRef(true), busyKeys = useRef(new Set<string>()), catalogSequence = useRef(0), currentOwner = useRef(owner), currentRepo = useRef(chosen)
  const seenTasks = useRef(new Set<string>()), previousLogin = useRef<string>(), environmentReady = useRef(false)
  currentOwner.current = owner; currentRepo.current = chosen
  const errorText = (error: unknown) => {
    const code = error instanceof Error ? error.message : String(error)
    return t(errorCodes.includes(code as typeof errorCodes[number]) ? code as typeof errorCodes[number] : 'commandFailed')
  }
  const run = async (key: string, work: () => Promise<void>) => {
    if (busyKeys.current.has(key)) return
    busyKeys.current.add(key); setPending([...busyKeys.current]); setError('')
    try { await work() } catch (error) { if (mounted.current) setError(errorText(error)) }
    finally { busyKeys.current.delete(key); if (mounted.current) setPending([...busyKeys.current]) }
  }
  const showStatus = (next: ProjectStatus) => {
    if (!mounted.current || currentRepo.current !== next.project.fullName) return
    setStatus(next); setSelected(next.changes.filter(change => !change.blocked).slice(0, 100).map(change => change.path)); setPreview(undefined); setVisibleFiles(100)
  }
  const loadStatus = (name: string) => run('status:' + name, async () => showStatus(await remote.status(name)))
  const loadCatalog = async (scope: Owner, nextPage = 1) => {
    const sequence = ++catalogSequence.current
    setCatalogLoading(true)
    try {
      const list = await remote.repositories(nextPage, scope)
      if (!mounted.current || sequence !== catalogSequence.current) return
      setRepositories(current => nextPage === 1 ? list : [...current, ...list.filter(repo => !current.some(item => item.fullName === repo.fullName))])
      setPage(nextPage); setMore(list.length === 30)
    } catch (error) { if (mounted.current && sequence === catalogSequence.current) setError(errorText(error)) }
    finally { if (mounted.current && sequence === catalogSequence.current) setCatalogLoading(false) }
  }
  const refreshAccount = async () => {
    const next = await remote.state()
    if (!mounted.current) return
    setState(next); setActivity(current => ({ ...current, projects: next.projects, login: next.login }))
    environmentReady.current = next.ghReady
    if (!next.account) { setOwners([]); setRepositories([]); return }
    const personal: Owner = { login: next.account.login, kind: 'personal' }
    const scope = currentOwner.current ?? personal
    if (!currentOwner.current) { setOwner(personal); currentOwner.current = personal }
    setOwners(current => current.length ? current : [personal])
    void loadCatalog(scope)
    try { const list = await remote.owners(); if (mounted.current) setOwners(list) }
    catch (error) { if (mounted.current) setError(errorText(error)) }
  }
  const selectRepository = (name: string) => {
    currentRepo.current = name; setChosen(name); setStatus(undefined); setPreview(undefined); setSelected([]); setNotice('')
    if (activity.projects.some(project => project.fullName === name && project.workspaceId)) void loadStatus(name)
  }
  const chooseOwner = (scope: Owner) => {
    currentOwner.current = scope; setOwner(scope); setQuery(''); setRepositories([]); selectRepository(''); void loadCatalog(scope)
  }
  const useRecent = (project: Project) => {
    const login = project.fullName.split('/')[0]!
    const scope = owners.find(item => item.login.toLowerCase() === login.toLowerCase()) ?? { login: '', kind: 'collaborator' as const }
    if (!currentOwner.current || ownerKey(currentOwner.current) !== ownerKey(scope)) { setOwner(scope); currentOwner.current = scope; setRepositories([]); setQuery(''); void loadCatalog(scope) }
    selectRepository(project.fullName)
  }
  useEffect(() => {
    mounted.current = true; void run('account', refreshAccount)
    let timer: ReturnType<typeof setTimeout> | undefined, disposed = false
    const poll = async () => {
      let delay = 5000
      try {
        const next = await remote.activity()
        if (disposed || !mounted.current) return
        setActivity(next)
        if (next.tools.status === 'ready' && !environmentReady.current) void run('account', refreshAccount)
        if (next.tools.status !== 'ready' && next.tools.status !== 'failed') delay = 1000
        if (next.tasks.some(active) || next.login?.status === 'pending') delay = 1000
        for (const task of next.tasks) {
          if (active(task) || seenTasks.current.has(task.id)) continue
          seenTasks.current.add(task.id)
          if (task.status === 'complete' && task.fullName === currentRepo.current) { void loadStatus(task.fullName); setNotice(t(task.kind === 'open' ? 'workspaceAdded' : 'autoSaved')) }
        }
        if (previousLogin.current === 'pending' && next.login?.status === 'complete') void run('account', refreshAccount)
        previousLogin.current = next.login?.status
      } catch (error) { if (!disposed && mounted.current) setError(errorText(error)) }
      if (!disposed) timer = setTimeout(() => { void poll() }, delay)
    }
    void poll()
    return () => { disposed = true; mounted.current = false; ++catalogSequence.current; clearTimeout(timer) }
  }, [])
  const project = activity.projects.find(project => project.fullName === chosen)
  const scopeProjects = activity.projects.filter(project => owner?.kind === 'collaborator' || project.fullName.split('/')[0]?.toLowerCase() === owner?.login.toLowerCase())
  const options = [...repositories, ...scopeProjects.filter(project => !repositories.some(repo => repo.fullName === project.fullName)).map(project => ({ fullName: project.fullName, private: false, writable: true, defaultBranch: '' }))].filter(repo => repo.fullName.toLowerCase().includes(query.toLowerCase()))
  const groups = [...new Set(options.map(repo => repo.fullName.split('/')[0]!))]
  const paths = [...new Set(status?.changes.filter(change => selected.includes(change.path)).flatMap(change => change.paths) ?? [])]
  const projectTask = activity.tasks.find(task => task.fullName === chosen && active(task))
  const latestTask = activity.tasks.filter(task => task.fullName === chosen).at(-1)
  const projectBusy = !!projectTask || pending.some(key => key.endsWith(':' + chosen) && !key.startsWith('status:'))
  const config = project?.autoSync
  const startOpen = () => run('open:' + chosen, async () => {
    const task = await remote.startOpen(chosen)
    if (mounted.current) setActivity(current => ({ ...current, tasks: [...current.tasks.filter(item => item.id !== task.id), task] }))
  })
  const configure = (enabled: boolean, minutes: number) => run('policy:' + chosen, async () => {
    const next = await remote.configureSync(chosen, enabled, minutes)
    if (mounted.current) setActivity(current => ({ ...current, projects: current.projects.map(project => project.fullName === next.fullName ? next : project) }))
  })
  const applyProject = (key: string, work: () => Promise<ProjectStatus>) => run(key + ':' + chosen, async () => showStatus(await work()))
  const tasks = activity.tasks.filter(active)
  return <section className="ghw">
    <header className="ghw-header"><div className="ghw-heading"><span className="ghw-brand"><BranchIcon /></span><div><h2>{t('dashboardTitle')}</h2><p>{t('dashboardIntro')}</p></div></div>
      <div className="ghw-account"><span className={'ghw-dot' + (state?.account ? ' is-connected' : '')} /><span>{state?.account?.login ?? t('notConnected')}</span><button className="ghw-button is-quiet" disabled={pending.includes('account')} aria-label={t('refresh')} onClick={() => { void run('account', refreshAccount) }}>↻</button><button className="ghw-button is-quiet" disabled={pending.includes('login') || !state?.ghReady || activity.login?.status === 'pending'} onClick={() => { void run('login', async () => { const login = await remote.beginLogin(); if (mounted.current) { previousLogin.current = 'pending'; setActivity(current => ({ ...current, login })) } }) }}>{t(state?.account ? 'accountSettings' : 'signInButton')}</button></div>
    </header>
    {activity.tools.status !== 'ready' && <div className={'ghw-banner' + (activity.tools.status === 'failed' ? ' is-error' : '')} role="status">
      {activity.tools.status !== 'failed' && <span className="ghw-spinner" />}
      <span>{activity.tools.status === 'failed' ? errorText(activity.tools.error ?? 'toolDownload') : t(activity.tools.status === 'downloading' ? 'setupDownloading' : activity.tools.status === 'verifying' ? 'setupVerifying' : 'setupChecking')}{activity.tools.progress === undefined ? '' : ' · ' + activity.tools.progress + '%'}</span>
      {activity.tools.status === 'failed' && <button className="ghw-button" onClick={() => { void run('initialize', async () => { const tools = await remote.initialize(); if (mounted.current) setActivity(current => ({ ...current, tools })) }) }}>{t('setupRetry')}</button>}
    </div>}
    {state && !state.gitReady && <div className="ghw-banner" role="status">{t('installHint')}</div>}
    {activity.login?.status === 'pending' && <div className="ghw-banner ghw-login"><span>{t('loginWaiting')}</span><code>{activity.login.code ?? '…'}</code><a href="https://github.com/login/device" target="_blank" rel="noreferrer">{t('loginPage')}</a><button className="ghw-button is-quiet" onClick={() => { void run('login', async () => { await remote.cancelLogin(); setActivity(await remote.activity()) }) }}>{t('cancel')}</button></div>}
    {activity.login?.status === 'failed' && <div className="ghw-banner" role="status">{t('loginFailed')}</div>}
    {error && <div className="ghw-banner is-error" role="alert">{error}<button className="ghw-dismiss" aria-label={t('dismiss')} onClick={() => setError('')}>×</button></div>}
    {notice && <div className="ghw-banner is-success" role="status">{notice}<button className="ghw-dismiss" aria-label={t('dismiss')} onClick={() => setNotice('')}>×</button></div>}
    <section className="ghw-picker" aria-label={t('chooseRepository')}>
      <div className="ghw-field ghw-owner"><label htmlFor="ghw-owner">{t('owner')}</label><select id="ghw-owner" value={owner ? ownerKey(owner) : ''} disabled={!state?.account} onChange={event => { const scope = owners.find(item => ownerKey(item) === event.target.value); if (scope) chooseOwner(scope) }}>
        {!owner && <option value="">{t('chooseOwner')}</option>}
        <optgroup label={t('personalAccount')}>{owners.filter(item => item.kind === 'personal').map(item => <option key={ownerKey(item)} value={ownerKey(item)}>{item.login}</option>)}</optgroup>
        <optgroup label={t('organizations')}>{owners.filter(item => item.kind === 'organization').map(item => <option key={ownerKey(item)} value={ownerKey(item)}>{item.login}</option>)}</optgroup>
        {owners.filter(item => item.kind === 'collaborator').map(item => <option key={ownerKey(item)} value={ownerKey(item)}>{t('collaborations')}</option>)}
      </select></div>
      <div className="ghw-field ghw-repository"><label htmlFor="ghw-repository">{t('repositories')}{catalogLoading && <span className="ghw-spinner" aria-label={t('loadingRepositories')} />}</label><select id="ghw-repository" value={chosen} disabled={!owner} onChange={event => selectRepository(event.target.value)}>
        <option value="">{t(catalogLoading ? 'loadingRepositories' : 'chooseRepository')}</option>{chosen && !options.some(repo => repo.fullName === chosen) && <option value={chosen}>{chosen}</option>}
        {groups.map(group => <optgroup key={group} label={group}>{options.filter(repo => repo.fullName.startsWith(group + '/')).map(repo => <option key={repo.fullName} value={repo.fullName}>{repo.fullName.slice(group.length + 1)}{repo.private ? ' · ' + t('private') : ''}{!repo.writable ? ' · ' + t('readOnly') : ''}</option>)}</optgroup>)}
      </select></div>
      <div className="ghw-field ghw-search"><label htmlFor="ghw-search">{t('filterRepositories')}</label><input id="ghw-search" type="search" placeholder={t('searchPlaceholder')} value={query} onChange={event => setQuery(event.target.value)} /></div>
      <button className="ghw-button is-primary ghw-open" disabled={!chosen || !state?.gitReady || !!projectTask || pending.includes('open:' + chosen)} onClick={() => { void startOpen() }}><BranchIcon />{t(projectTask?.kind === 'open' ? 'opening' : project ? 'reopen' : 'open')}</button>
      <div className="ghw-picker-footer"><span>{options.length} {t('repositoryCount')}{catalogLoading ? ' · ' + t('loadingRepositories') : ''}</span>{more && owner && <button className="ghw-link" disabled={catalogLoading} onClick={() => { void loadCatalog(owner, page + 1) }}>{t('loadMore')}</button>}<span className="ghw-grow" /><span>{t('downloadOnDemand')}</span></div>
    </section>
    {!!activity.projects.length && <nav className="ghw-recent" aria-label={t('projects')}><span>{t('recentProjects')}</span>{activity.projects.slice(-5).reverse().map(project => <button key={project.fullName} className={'ghw-chip' + (project.fullName === chosen ? ' is-selected' : '')} onClick={() => useRecent(project)}>{project.fullName}</button>)}</nav>}
    {!!tasks.length && <div className="ghw-tasks" aria-live="polite">{tasks.map(task => <TaskCard key={task.id} task={task} t={t} onCancel={() => { void run('cancel:' + task.id, async () => { const next = await remote.cancelTask(task.id); if (mounted.current) setActivity(current => ({ ...current, tasks: current.tasks.map(item => item.id === next.id ? next : item) })) }) }} />)}</div>}
    {latestTask?.status === 'failed' && <div className="ghw-banner is-error" role="status">{errorText(latestTask.error ?? 'commandFailed')}</div>}
    {latestTask?.status === 'cancelled' && <div className="ghw-banner" role="status">{t('taskCancelled')}</div>}
    {chosen && <EncryptionSettings key={chosen} remote={remote} fullName={chosen} t={t} disabled={projectBusy} forceOpen={!!latestTask?.error?.startsWith('encryption') || latestTask?.error === 'cryptMissing'} save={encryption => run('encryption:' + chosen, async () => {
      const project = await remote.configureEncryption(chosen, encryption)
      if (!mounted.current) return
      if (currentRepo.current === project.fullName) { setStatus(undefined); setPreview(undefined) }
      setActivity(current => ({ ...current, projects: [...current.projects.filter(item => item.fullName !== project.fullName), project] }))
      const task = await remote.startOpen(project.fullName)
      if (mounted.current) setActivity(current => ({ ...current, tasks: [...current.tasks.filter(item => item.id !== task.id), task] }))
    })} />}
    {!project?.workspaceId ? <div className="ghw-empty"><span className="ghw-empty-icon"><BranchIcon /></span><h3>{t(chosen ? 'readyToOpen' : 'chooseProjectTitle')}</h3><p>{t(chosen ? 'openHint' : 'chooseProjectHint')}</p>{chosen && <code>{chosen}</code>}</div> : <>
      <div className="ghw-project-header"><div><div className="ghw-eyebrow">{t('workspace')}</div><h3>{project.fullName}</h3><span className="ghw-project-path" title={project.path}>{project.path}</span></div><a className="ghw-button is-quiet" href={'https://github.com/' + project.fullName} target="_blank" rel="noreferrer">{t('repoLink')} ↗</a></div>
      <nav className="ghw-tabs" aria-label={t('projectViews')}><button className={tab === 'overview' ? 'is-selected' : ''} onClick={() => setTab('overview')}>{t('overview')}</button><button className={tab === 'changes' ? 'is-selected' : ''} onClick={() => setTab('changes')}>{t('changes')}<span>{status?.changes.length ?? '—'}</span></button><span className="ghw-grow" /><button className="ghw-refresh" aria-label={t('refresh')} title={t('refresh')} disabled={pending.includes('status:' + chosen)} onClick={() => { void loadStatus(chosen) }}><RefreshIcon /></button></nav>
      {tab === 'overview' && <div className="ghw-overview"><section className="ghw-card"><h4>{t('syncStatus')}</h4><div className="ghw-status-line"><span className="ghw-status-pill">{status?.branch ?? '…'}</span><span>{!status ? t('checking') : status.conflicted ? t('conflictHint') : status.changes.length ? t('localChangesPresent') : t('clean')}</span></div><div className="ghw-stats"><div><strong>{status?.ahead ?? '—'}</strong><span>{t('ahead')}</span></div><div><strong>{status?.behind ?? '—'}</strong><span>{t('behind')}</span></div><div><strong>{status?.changes.length ?? '—'}</strong><span>{t('changedFiles')}</span></div></div><p className="ghw-muted">{t('trackingHint')}</p><div className="ghw-actions"><button className="ghw-button" disabled={projectBusy || !status} onClick={() => { void applyProject('fetch', () => remote.fetch(chosen)) }}>{t('checkRemote')}</button><button className="ghw-button" disabled={projectBusy || !status || !!status.changes.length || status.conflicted} onClick={() => { void applyProject('pull', () => remote.pull(chosen)) }}>{t('pull')}</button><button className="ghw-button is-primary" disabled={projectBusy || !status?.head || status.ahead === 0 || status.conflicted} onClick={() => { void applyProject('push', () => remote.push(chosen, status!.head)) }}>{t('push')}</button></div></section>
        <section className="ghw-card"><div className="ghw-card-title"><h4>{t('saveMode')}</h4><span className={'ghw-status-pill' + (config?.error ? ' is-paused' : config?.enabled ? ' is-auto' : '')}>{t(config?.error && config.enabled ? 'paused' : config?.enabled ? 'automatic' : 'manual')}</span></div><div className="ghw-policy"><label htmlFor="ghw-mode">{t('saveMode')}</label><select id="ghw-mode" value={config?.enabled ? 'auto' : 'manual'} disabled={pending.includes('policy:' + chosen)} onChange={event => { void configure(event.target.value === 'auto', config?.intervalMinutes ?? 5) }}><option value="manual">{t('manualMode')}</option><option value="auto">{t('automaticMode')}</option></select></div><p className="ghw-muted">{t(config?.enabled ? 'autoHint' : 'manualHint')}</p>
          {config?.enabled && <><div className="ghw-policy"><label htmlFor="ghw-interval">{t('syncInterval')}</label><select id="ghw-interval" value={config.intervalMinutes} disabled={projectBusy} onChange={event => { void configure(true, Number(event.target.value)) }}>{[1, 5, 15, 30, 60].map(value => <option key={value} value={value}>{value} {t('minutes')}</option>)}</select></div><p className="ghw-muted">{t('branch')}: <code>{config.branch}</code>{config.lastSyncAt ? ' · ' + t('lastSaved') + ' ' + new Date(config.lastSyncAt).toLocaleTimeString() : ''}</p>{config.error && <p className="ghw-policy-error">{errorText(config.error)}</p>}<button className="ghw-button" disabled={projectBusy} onClick={() => { void run('sync:' + chosen, async () => { if (config.error) await remote.configureSync(chosen, true, config.intervalMinutes); const task = await remote.startSync(chosen); if (mounted.current) setActivity(current => ({ ...current, tasks: [...current.tasks.filter(item => item.id !== task.id), task] })) }) }}>{t(config.error ? 'resumeSync' : 'syncNow')}</button></>}
        </section></div>}
      {tab === 'changes' && <div className="ghw-changes"><section className="ghw-card ghw-files"><div className="ghw-card-title"><h4>{t('changes')}</h4><span className="ghw-muted">{selected.length} / {status?.changes.length ?? 0}</span></div>{!status ? <p className="ghw-muted">{t('working')}</p> : !status.changes.length ? <div className="ghw-small-empty">{t('clean')}</div> : <><div className="ghw-file-list">{status.changes.slice(0, visibleFiles).map(change => <label key={change.path} className={'ghw-file' + (change.blocked ? ' is-blocked' : '')} title={change.blocked ? t('blocked') : change.path}><input type="checkbox" disabled={projectBusy || change.blocked || (!selected.includes(change.path) && selected.length >= 100)} checked={selected.includes(change.path)} onChange={event => { setPreview(undefined); setSelected(current => event.target.checked ? [...current, change.path] : current.filter(path => path !== change.path)) }} /><code>{change.status.trim() || 'M'}</code><span>{change.path}</span></label>)}</div>{status.changes.length > visibleFiles && <button className="ghw-link" onClick={() => setVisibleFiles(value => value + 100)}>{t('loadMore')}</button>}<p className="ghw-muted">{t('selectionLimit')}</p><button className="ghw-button is-primary" disabled={projectBusy || !paths.length || paths.length > 100 || status.conflicted} onClick={() => { void run('preview:' + chosen, async () => { const next = await remote.preview(chosen, paths); if (mounted.current && next.fullName === currentRepo.current) { setPreview(next); setMessage(next.message) } }) }}>{t('preview')}</button></>}</section>
        <section className="ghw-card ghw-diff">{preview ? <><h4>{t('review')}</h4><pre>{preview.diff}</pre><label htmlFor="ghw-message">{t('message')}</label><textarea id="ghw-message" value={message} disabled={projectBusy} onChange={event => setMessage(event.target.value)} maxLength={1000} /><button className="ghw-button is-primary" disabled={projectBusy || !message.trim()} onClick={() => { void run('commit:' + chosen, async () => { const next = await remote.commit(preview.id, message); showStatus(next); if (mounted.current && next.project.fullName === currentRepo.current) setNotice(t('committed')) }) }}>{t('commit')}</button></> : <div className="ghw-small-empty"><h4>{t('review')}</h4><p>{t('reviewHint')}</p></div>}</section>
      </div>}
    </>}
  </section>
}
function TaskCard({ task, t, onCancel }: { task: Task; t: Translate; onCancel(): void }) {
  return <section className="ghw-task"><span className="ghw-spinner" /><div className="ghw-task-body"><strong>{task.fullName}</strong><span>{t(task.status === 'cancelling' ? 'cancelling' : task.phase)}{task.progress === undefined ? '' : ` · ${task.progress}%`}</span><progress max={100} value={task.progress} aria-label={t(task.phase)} /></div><button className="ghw-button is-quiet" disabled={task.status === 'cancelling'} onClick={onCancel}>{t('cancelTask')}</button></section>
}
function EncryptionSettings({ remote, fullName, t, disabled, forceOpen, save }: { remote: Remote; fullName: string; t: Translate; disabled: boolean; forceOpen: boolean; save(value: Encryption | null): Promise<void> }) {
  const [mode, setMode] = useState('detect'), [keyFile, setKeyFile] = useState(''), [binaryPath, setBinaryPath] = useState('')
  const [expanded, setExpanded] = useState(forceOpen), [loading, setLoading] = useState(true), [failed, setFailed] = useState(false)
  useEffect(() => { if (forceOpen) setExpanded(true) }, [forceOpen])
  useEffect(() => {
    let disposed = false
    void remote.encryption(fullName).then(config => { if (!disposed) { setMode(config?.keySource ?? 'detect'); setKeyFile(config?.keySource === 'file' ? config.keyFile : ''); setBinaryPath(config?.binaryPath ?? '') } })
      .catch(() => { if (!disposed) setFailed(true) }).finally(() => { if (!disposed) setLoading(false) })
    return () => { disposed = true }
  }, [fullName, remote])
  return <details className="ghw-card ghw-encryption" open={expanded} onToggle={event => setExpanded(event.currentTarget.open)}>
    <summary><span className="ghw-disclosure-title">{t('encryptionTitle')}</span><span className="ghw-muted">{t(mode === 'detect' ? 'encryptionDetect' : 'encryptionConfigured')}</span></summary>
    <form onSubmit={event => { event.preventDefault(); void save(mode === 'detect' ? null : { mode: 'git-crypt', ...(mode === 'file' ? { keySource: 'file', keyFile: keyFile.trim() } : { keySource: 'gpg' }), ...(binaryPath.trim() ? { binaryPath: binaryPath.trim() } : {}) }) }}>
      <p className="ghw-muted">{t('encryptionHint')}</p>
      {failed && <p className="ghw-policy-error">{t('commandFailed')}</p>}
      <div className="ghw-encryption-fields"><div className="ghw-field"><label htmlFor="ghw-encryption-mode">{t('encryptionMethod')}</label><select id="ghw-encryption-mode" value={mode} disabled={disabled || loading || failed} onChange={event => setMode(event.target.value)}><option value="detect">{t('encryptionDetect')}</option><option value="file">{t('encryptionFile')}</option><option value="gpg">{t('encryptionGpg')}</option></select></div>
        {mode === 'file' && <div className="ghw-field"><label htmlFor="ghw-key-file">{t('encryptionKeyFile')}</label><input id="ghw-key-file" type="text" value={keyFile} disabled={disabled || loading} required placeholder="~/.config/git-crypt/private-notes.key" onChange={event => setKeyFile(event.target.value)} autoComplete="off" spellCheck={false} /></div>}
      </div>
      {mode !== 'detect' && <><p className="ghw-muted">{t(mode === 'gpg' ? 'encryptionGpgHint' : 'encryptionFileHint')}</p><details className="ghw-encryption-advanced"><summary>{t('encryptionAdvanced')}</summary><div className="ghw-field"><label htmlFor="ghw-crypt-binary">{t('encryptionBinary')}</label><input id="ghw-crypt-binary" type="text" value={binaryPath} placeholder={t('encryptionBinaryPlaceholder')} onChange={event => setBinaryPath(event.target.value)} disabled={disabled || loading} autoComplete="off" spellCheck={false} /></div></details></>}
      <button className="ghw-button" type="submit" disabled={disabled || loading || failed || (mode === 'file' && !keyFile.trim())}>{t('encryptionSave')}</button>
    </form>
  </details>
}
function BranchIcon() { return <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" aria-hidden="true"><circle cx="6" cy="5" r="2.5" /><circle cx="6" cy="19" r="2.5" /><circle cx="18" cy="6" r="2.5" /><path d="M6 7.5v9M18 8.5c0 5-12 2-12 8" /></svg> }
function RefreshIcon() { return <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M20 7v5h-5M4 17v-5h5M6 7a7 7 0 0 1 12-1l2 3M4 15l2 3a7 7 0 0 0 12-1" /></svg> }
