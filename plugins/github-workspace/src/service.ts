import { AsyncLocalStorage } from 'node:async_hooks'
import { createHash, randomUUID } from 'node:crypto'
import { lstat, mkdir, mkdtemp, open, readFile, readdir, realpath, rename, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { z } from 'zod'
import { Git, type GitIdentity } from './git.js'
import { GitHub, repositoryName } from './github.js'
import { httpsRepository, httpsRepositoryPath, readHttpsSettings, type HttpsSettings } from './https-remote.js'
import { commandEnvironment, execute, type Execute } from './process.js'
import { Tasks } from './tasks.js'
import { EncryptionSupport, encryptionSchema } from './encryption.js'
import { Tools } from './tools.js'
import { errorCodes, projectKey, repositoryKey, WorkspaceError, type Account, type Activity, type Encryption, type Preview, type Project, type State, type TaskPhase } from './types.js'

export interface WorkspaceRegistry { create(path: string, title?: string): Promise<{ id: string }> }
const autoSyncSchema = z.strictObject({ enabled: z.boolean(), intervalMinutes: z.number().int().min(1).max(60), branch: z.string().min(1), account: z.string().min(1), lastSyncAt: z.number().optional(), error: z.enum(errorCodes).optional() })
  .transform(({ lastSyncAt, error, ...required }) => ({ ...required, ...(lastSyncAt === undefined ? {} : { lastSyncAt }), ...(error === undefined ? {} : { error }) }))
const projectFields = { path: z.string(), workspaceId: z.string(), account: z.string() }
const projectSchema = z.union([
  z.strictObject({ ...projectFields, fullName: repositoryName, autoSync: autoSyncSchema.optional() })
    .transform(({ autoSync, ...required }) => ({ ...required, ...(autoSync === undefined ? {} : { autoSync }) })),
  z.strictObject({ ...projectFields, fullName: z.string(), account: z.literal(''), remoteUrl: httpsRepository })
    .refine(project => project.fullName === httpsRepositoryPath(project.remoteUrl)),
])
const storeSchema = z.strictObject({ owner: z.literal('dsh-github-workspace/v1'), projects: z.array(projectSchema).max(1000) })
const projectSelector = z.union([repositoryName, httpsRepository])
const empty = z.strictObject({}), repoRequest = z.strictObject({ fullName: projectSelector })
const encryptionFileSchema = z.strictObject({ version: z.literal(1), repositories: z.record(z.string().refine(key => { const parsed = projectSelector.safeParse(key); return parsed.success && parsed.data === key }), encryptionSchema) })
  .refine(file => Object.keys(file.repositories).length <= 1000 && new Set(Object.keys(file.repositories).map(repositoryKey)).size === Object.keys(file.repositories).length)
const schemas = {
  state: empty, initialize: empty, beginLogin: empty, cancelLogin: empty, owners: empty, activity: empty,
  configureEncryption: z.strictObject({ fullName: projectSelector, encryption: encryptionSchema.nullable() }),
  encryption: repoRequest,
  repositories: z.strictObject({ page: z.number().int().min(1).max(100), owner: z.strictObject({ login: z.string().max(39).regex(/^[A-Za-z0-9-]*$/), kind: z.enum(['personal', 'organization', 'collaborator']) }).optional() }),
  startOpen: repoRequest, startOpenHttps: z.strictObject({ url: z.string().max(1024) }),
  startSync: z.strictObject({ fullName: repositoryName }), cancelTask: z.strictObject({ id: z.string().uuid() }),
  configureSync: z.strictObject({ fullName: repositoryName, enabled: z.boolean(), intervalMinutes: z.number().int().min(1).max(60) }),
  open: repoRequest, status: repoRequest, fetch: repoRequest, pull: repoRequest,
  preview: z.strictObject({ fullName: projectSelector, paths: z.array(z.string().min(1).max(4096)).min(1).max(100) }),
  commit: z.strictObject({ id: z.string().uuid(), message: z.string().trim().min(1).max(1000).refine(value => !/[\u0000-\u0008\u000b-\u001f]/u.test(value)) }),
  push: z.strictObject({ fullName: projectSelector, head: z.string().regex(/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/) }),
}

const githubIdentity = (account: Account): GitIdentity => ({ name: account.login, email: `${account.id}+${account.login}@users.noreply.github.com` })

export class WorkspaceService {
  private readonly lifetime = new AbortController()
  private readonly scopes = new AsyncLocalStorage<AbortSignal>()
  private readonly jobs = new Set<Promise<unknown>>()
  private readonly previews = new Map<string, Preview>()
  private readonly tasks = new Tasks()
  private readonly nextSync = new Map<string, number>()
  private timer: ReturnType<typeof setTimeout> | undefined
  private readonly github: GitHub
  private readonly git: Git
  private readonly httpsGit: Git | undefined
  private readonly tools: Tools
  private readonly encryption: EncryptionSupport
  private readonly encryptionFile: string
  private root: string
  private init: Promise<void> | undefined
  private stopped = false
  private constructor(home: string, private readonly registry: WorkspaceRegistry, private readonly scratch: string, private readonly run: Execute,
    private readonly https: HttpsSettings | undefined) {
    this.root = join(home, 'github-workspace')
    this.encryptionFile = join(home, 'github-workspace.encryption.json')
    this.tools = new Tools(join(this.root, 'tools'), run, () => this.ensureRoot())
    const managedRun: Execute = (command, args, options) => this.tools.run(command, args, options)
    const options = () => ({ env: { ...this.tools.environment(), TMPDIR: scratch }, signal: this.scopes.getStore() ?? this.lifetime.signal })
    this.encryption = new EncryptionSupport(managedRun, options, scratch, join(scratch, 'hooks'))
    this.github = new GitHub(managedRun, options)
    this.git = new Git(managedRun, options, join(scratch, 'hooks'), this.encryption)
    if (https) this.httpsGit = new Git(run, () => ({ env: { ...commandEnvironment(), TMPDIR: scratch, GCM_INTERACTIVE: 'never' },
      signal: this.scopes.getStore() ?? this.lifetime.signal }), join(scratch, 'hooks'), this.encryption, https)
  }
  static async create(home: string, registry: WorkspaceRegistry, run: Execute = execute): Promise<WorkspaceService> {
    const scratch = await mkdtemp(join(tmpdir(), 'dsh-github-workspace-'))
    await mkdir(join(scratch, 'hooks'))
    const service = new WorkspaceService(home, registry, scratch, run, await readHttpsSettings(join(home, 'github-workspace.https.json')))
    service.tools.start()
    service.schedule()
    return service
  }
  async stop(): Promise<void> {
    this.stopped = true; this.lifetime.abort()
    clearTimeout(this.timer)
    await this.tools.close()
    await this.tasks.stop()
    await this.github.cancelLogin()
    await Promise.allSettled([...this.jobs])
    this.previews.clear()
    await rm(this.scratch, { recursive: true, force: true })
  }
  /** The human-operated page is the only mutation entry point. */
  async request(method: string, payload: unknown, signal?: AbortSignal): Promise<unknown> {
    if (this.stopped) throw new WorkspaceError('stopped')
    if (!Object.hasOwn(schemas, method)) throw new WorkspaceError('invalidRequest')
    const schema = schemas[method as keyof typeof schemas]
    if (!schema.safeParse(payload).success) throw new WorkspaceError('invalidRequest')
    const job = this.scopes.run(AbortSignal.any([this.lifetime.signal, ...(signal ? [signal] : [])]), async () => {
      this.scopes.getStore()!.throwIfAborted()
      // Each branch parses its own schema so dispatch retains precise types.
      switch (method) {
        case 'state': return this.state()
        case 'initialize': return this.tools.start(true)
        case 'encryption': {
          const { fullName } = schemas.encryption.parse(payload)
          return this.encryptionFor(fullName)
        }
        case 'configureEncryption': {
          const input = schemas.configureEncryption.parse(payload)
          await this.tasks.cancelSync(input.fullName)
          return this.exclusive(() => this.configureEncryption(input.fullName, input.encryption))
        }
        case 'beginLogin': return this.github.beginLogin()
        case 'cancelLogin': await this.github.cancelLogin(); return null
        case 'owners': return this.github.owners()
        case 'repositories': { const input = schemas.repositories.parse(payload); return this.github.repositories(input.page, input.owner) }
        case 'activity': return this.activity()
        case 'startOpen': return this.startOpen(schemas.startOpen.parse(payload).fullName)
        case 'startOpenHttps': {
          const url = httpsRepository.safeParse(schemas.startOpenHttps.parse(payload).url)
          if (!url.success) throw new WorkspaceError('httpsUrl')
          return this.startOpen(url.data)
        }
        case 'cancelTask': return this.tasks.cancel(schemas.cancelTask.parse(payload).id)
        case 'configureSync': {
          const input = schemas.configureSync.parse(payload)
          if (!input.enabled) await this.tasks.cancelSync(input.fullName)
          return this.exclusive(() => this.configureSync(input.fullName, input.enabled, input.intervalMinutes))
        }
        case 'startSync': return this.startSync(schemas.startSync.parse(payload).fullName)
        case 'open': return this.exclusive(() => this.openProject(schemas.open.parse(payload).fullName))
        case 'status': return this.projectCommand('status', schemas.status.parse(payload).fullName)
        case 'fetch': case 'pull': return this.exclusive(() => this.projectCommand(method, schemas[method].parse(payload).fullName))
        case 'preview': { const input = schemas.preview.parse(payload); return this.exclusive(() => this.preview(input.fullName, input.paths)) }
        case 'commit': { const input = schemas.commit.parse(payload); return this.exclusive(() => this.commit(input.id, input.message)) }
        case 'push': { const input = schemas.push.parse(payload); return this.exclusive(async () => {
          const project = await this.project(input.fullName)
          return this.gitFor(project.remoteUrl).push(project, input.head)
        }) }
        default: throw new WorkspaceError('invalidRequest')
      }
    })
    this.jobs.add(job)
    try { return await job } finally { this.jobs.delete(job) }
  }
  private startOpen(selector: string) {
    if (selector.startsWith('https://')) this.gitFor(selector)
    return this.tasks.start(selector, 'open', (abort, report) => this.scopes.run(AbortSignal.any([abort, this.lifetime.signal]),
      () => this.exclusive(() => this.openProject(selector, report))))
  }
  private gitFor(remoteUrl: string | undefined): Git {
    if (remoteUrl === undefined) return this.git
    if (!this.httpsGit || new URL(remoteUrl).hostname !== this.https?.host) throw new WorkspaceError('httpsHost')
    return this.httpsGit
  }
  private async projectCommand(method: 'status' | 'fetch' | 'pull', selector: string) {
    const project = await this.project(selector)
    return this.gitFor(project.remoteUrl)[method](project)
  }
  private path(fullName: string): string {
    const key = createHash('sha256').update(repositoryKey(fullName)).digest('hex').slice(0, 32)
    return join(this.root, 'projects', key)
  }
  private async encryptionFor(selector: string): Promise<Encryption | null> {
    return Object.entries((await this.readEncryption()).repositories).find(([key]) => repositoryKey(key) === repositoryKey(selector))?.[1] ?? null
  }
  private async readEncryption(): Promise<z.infer<typeof encryptionFileSchema>> {
    try {
      const info = await lstat(this.encryptionFile)
      if (!info.isFile() || info.isSymbolicLink() || info.size > 1024 * 1024) throw new WorkspaceError('unsafeDirectory')
      return encryptionFileSchema.parse(JSON.parse(await readFile(this.encryptionFile, 'utf8')))
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { version: 1, repositories: {} }
      throw error instanceof WorkspaceError ? error : new WorkspaceError('encryptionUnsafe')
    }
  }
  private async readStore(): Promise<{ owner: 'dsh-github-workspace/v1'; projects: Project[] }> {
    const info = await lstat(join(this.root, 'state.json'))
    if (!info.isFile() || info.isSymbolicLink() || info.size > 1024 * 1024) throw new WorkspaceError('unsafeDirectory')
    const store = storeSchema.parse(JSON.parse(await readFile(join(this.root, 'state.json'), 'utf8')))
    const selectors = store.projects.map(projectKey)
    if (store.projects.some(project => project.path !== this.path(projectKey(project))) || new Set(selectors.map(repositoryKey)).size !== store.projects.length) throw new WorkspaceError('unsafeDirectory')
    const configurations = new Map(Object.entries((await this.readEncryption()).repositories).map(([key, value]) => [repositoryKey(key), value]))
    return { ...store, projects: store.projects.map(project => {
      const encryption = configurations.get(repositoryKey(projectKey(project)))
      return { ...project, ...(encryption ? { encryption } : {}) }
    }) }
  }
  private async ensureRoot(): Promise<void> {
    this.init ??= (async () => {
      await mkdir(this.root, { recursive: true, mode: 0o700 })
      const info = await lstat(this.root)
      if (!info.isDirectory() || info.isSymbolicLink()) throw new WorkspaceError('unsafeDirectory')
      this.root = await realpath(this.root)
      try { await this.readStore() } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
        if ((await readdir(this.root)).length) throw new WorkspaceError('unsafeDirectory')
        const file = await open(join(this.root, 'state.json'), 'wx', 0o600)
        try { await file.writeFile(JSON.stringify({ owner: 'dsh-github-workspace/v1', projects: [] })) } finally { await file.close() }
      }
      await mkdir(join(this.root, 'projects'), { mode: 0o700, recursive: true })
      const projects = await lstat(join(this.root, 'projects'))
      if (!projects.isDirectory() || projects.isSymbolicLink()) throw new WorkspaceError('unsafeDirectory')
    })().catch(error => { this.init = undefined; throw error })
    await this.init
    for (const path of [this.root, join(this.root, 'projects')]) {
      const info = await lstat(path)
      if (!info.isDirectory() || info.isSymbolicLink() || await realpath(path) !== path) throw new WorkspaceError('unsafeDirectory')
    }
  }
  private async writeProjects(projects: Project[]): Promise<void> {
    const temporary = join(this.root, 'state-' + randomUUID() + '.tmp')
    const file = await open(temporary, 'wx', 0o600)
    try { await file.writeFile(JSON.stringify({ owner: 'dsh-github-workspace/v1', projects: projects.map(({ encryption: _encryption, ...project }) => project) })); await file.sync() }
    finally { await file.close() }
    try { await rename(temporary, join(this.root, 'state.json')) } finally { await rm(temporary, { force: true }) }
  }
  private async exclusive<T>(work: () => Promise<T>): Promise<T> {
    await this.ensureRoot()
    const lockPath = join(this.root, '.operation.lock')
    let lock
    try { lock = await open(lockPath, 'wx', 0o600) } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new WorkspaceError('busy')
      throw error
    }
    try { return await work() } finally { await lock.close(); await rm(lockPath) }
  }
  private async state(): Promise<State> {
    let account = null, ghReady = false, gitReady = false
    const options = { env: commandEnvironment(), signal: this.scopes.getStore() ?? this.lifetime.signal, timeoutMs: 10_000 }
    try { ghReady = this.tools.state().status === 'ready'; if (ghReady) account = await this.github.account() } catch { /* Missing CLI or an expired account is page state, never raw stderr. */ }
    try { gitReady = (await this.run('git', ['--version'], options)).code === 0 } catch { /* Same policy as gh. */ }
    let projects: Project[] = []
    try { await this.ensureRoot(); projects = (await this.readStore()).projects } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
    return { account, ghReady, gitReady, projects, ...(this.https ? { httpsHost: this.https.host } : {}), login: this.github.login ? { ...this.github.login } : null, tools: this.tools.state() }
  }
  private async project(fullName: string): Promise<Project> {
    await this.ensureRoot()
    const project = (await this.readStore()).projects.find(project => repositoryKey(projectKey(project)) === repositoryKey(fullName))
    if (!project || !project.workspaceId) throw new WorkspaceError('unknownProject')
    return project
  }
  private async openProject(selector: string, report?: (phase: TaskPhase, progress?: number) => void): Promise<Project> {
    report?.('checking')
    const remoteUrl = selector.startsWith('https://') ? selector : undefined
    const git = this.gitFor(remoteUrl)
    const account = remoteUrl ? '' : (await this.github.account()).login
    const fullName = remoteUrl ? httpsRepositoryPath(remoteUrl) : (await this.github.repository(selector)).fullName
    const projects = (await this.readStore()).projects
    const key = repositoryKey(remoteUrl ?? fullName)
    let project = projects.find(project => repositoryKey(projectKey(project)) === key)
    if (!project) {
      project = { fullName, path: this.path(key), workspaceId: '', account, ...(remoteUrl ? { remoteUrl } : {}) }
      const encryption = await this.encryptionFor(key)
      if (encryption) project.encryption = encryption
      try { await lstat(project.path); throw new WorkspaceError('unsafeDirectory') } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
      projects.push(project)
      // Persist ownership before placing a clone; a failed registration is retryable.
      await this.writeProjects(projects)
    }
    try { await lstat(project.path) } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      const stage = await mkdtemp(join(this.root, 'clone-'))
      try {
        await git.clone(stage, project, join(stage, 'repository'), report)
        try { await lstat(project.path); throw new WorkspaceError('unsafeDirectory') }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
        await rename(join(stage, 'repository'), project.path)
      }
      finally { await rm(stage, { recursive: true, force: true }) }
    }
    await git.verify(project)
    report?.('unlocking')
    await this.encryption.unlock(project, (args, options) => git.command(project.path, args, options))
    this.scopes.getStore()?.throwIfAborted()
    report?.('registering')
    const workspace = await this.registry.create(project.path, remoteUrl ? `${new URL(remoteUrl).hostname}/${fullName}` : fullName)
    project.workspaceId = workspace.id; project.account = account
    await this.writeProjects(projects)
    return project
  }
  private async withScratch<T>(work: (path: string) => Promise<T>): Promise<T> {
    const path = await mkdtemp(join(this.scratch, 'review-'))
    try { return await work(path) } finally { await rm(path, { recursive: true, force: true }) }
  }
  private async preview(fullName: string, paths: string[]): Promise<Preview> {
    const project = await this.project(fullName), git = this.gitFor(project.remoteUrl), state = await git.status(project)
    const staged = await this.withScratch(path => git.stage(project, paths, path))
    for (const [id, preview] of this.previews) if (preview.expiresAt < Date.now()) this.previews.delete(id)
    if (this.previews.size >= 20) this.previews.delete(this.previews.keys().next().value!)
    const preview: Preview = { id: randomUUID(), fullName: projectKey(project), head: state.head, tree: staged.tree, paths: [...paths],
      diff: staged.diff, message: `Update ${paths.length} file${paths.length === 1 ? '' : 's'} in ${project.fullName}`, expiresAt: Date.now() + 10 * 60_000 }
    this.previews.set(preview.id, preview)
    return preview
  }
  private async localIdentity(): Promise<GitIdentity> {
    const env = commandEnvironment()
    // Read only the two author fields. Managed Git commands keep global config disabled.
    delete env.GIT_CONFIG_GLOBAL
    const read = async (field: string) => {
      const result = await this.run('git', ['config', '--global', '--includes', '--get', field], {
        cwd: this.scratch, env, signal: this.scopes.getStore() ?? this.lifetime.signal, timeoutMs: 10_000, maxBytes: 4096,
      })
      const value = result.stdout.trim()
      if (result.code !== 0 || !value || /[\p{Cc}<>]/u.test(value)) throw new WorkspaceError('gitIdentity')
      return value
    }
    const name = await read('user.name'), email = await read('user.email')
    if (!/^[^\s@]+@[^\s@]+$/u.test(email)) throw new WorkspaceError('gitIdentity')
    return { name, email }
  }
  private async commit(id: string, message: string): Promise<unknown> {
    const preview = this.previews.get(id)
    if (!preview || preview.expiresAt < Date.now()) throw new WorkspaceError('stalePreview')
    const project = await this.project(preview.fullName), git = this.gitFor(project.remoteUrl)
    const identity = project.remoteUrl ? await this.localIdentity() : githubIdentity(await this.github.account())
    const result = await this.withScratch(path => git.commit(project, preview, message, identity, path))
    this.previews.delete(id)
    return result
  }
  private async activity(): Promise<Activity> {
    await this.ensureRoot()
    return { projects: (await this.readStore()).projects, tasks: this.tasks.list(), login: this.github.login ? { ...this.github.login } : null, tools: this.tools.state() }
  }
  private async configureEncryption(fullName: string, encryption: Encryption | null): Promise<Project> {
    const store = await this.readStore()
    const key = repositoryKey(fullName)
    let project = store.projects.find(project => repositoryKey(projectKey(project)) === key)
    if (fullName.startsWith('https://')) {
      this.gitFor(fullName)
      if (!project) throw new WorkspaceError('unknownProject')
    }
    if (!project) {
      const account = await this.github.account(), repo = await this.github.repository(fullName)
      project = { fullName: repo.fullName, path: this.path(repo.fullName), account: account.login, workspaceId: '' }
      try { await lstat(project.path); throw new WorkspaceError('unsafeDirectory') } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
      store.projects.push(project)
      await this.writeProjects(store.projects)
    }
    const config = await this.readEncryption()
    for (const name of Object.keys(config.repositories)) if (repositoryKey(name) === key) delete config.repositories[name]
    if (encryption) config.repositories[projectKey(project)] = encryption
    const temporary = this.encryptionFile + '.' + randomUUID() + '.tmp'
    const file = await open(temporary, 'wx', 0o600)
    try { await file.writeFile(JSON.stringify(config, null, 2) + '\n'); await file.sync() } finally { await file.close() }
    try { await rename(temporary, this.encryptionFile) } finally { await rm(temporary, { force: true }) }
    if (encryption) project.encryption = encryption; else delete project.encryption
    if (project.autoSync) project.autoSync = { ...project.autoSync, enabled: false }
    await this.writeProjects(store.projects)
    for (const [id, preview] of this.previews) if (preview.fullName === projectKey(project)) this.previews.delete(id)
    return project
  }
  private async configureSync(fullName: string, enabled: boolean, intervalMinutes: number): Promise<Project> {
    const project = await this.project(fullName)
    if (enabled) {
      const state = await this.git.status(project)
      const account = await this.github.account(), repository = await this.github.repository(fullName)
      if (!repository.writable) throw new WorkspaceError('readOnly')
      project.autoSync = { enabled, intervalMinutes, branch: state.branch, account: account.login, ...(project.autoSync?.lastSyncAt === undefined ? {} : { lastSyncAt: project.autoSync.lastSyncAt }) }
    } else if (project.autoSync) project.autoSync = { ...project.autoSync, enabled: false }
    const store = await this.readStore()
    await this.writeProjects(store.projects.map(item => projectKey(item) === project.fullName ? project : item))
    this.nextSync.set(project.fullName, Date.now() + intervalMinutes * 60_000)
    return project
  }
  private startSync(fullName: string) {
    return this.tasks.start(fullName, 'sync', (abort, report) => this.scopes.run(AbortSignal.any([abort, this.lifetime.signal]), () => this.exclusive(async () => {
      const project = await this.project(fullName)
      if (!project.autoSync?.enabled) throw new WorkspaceError('autoDisabled')
      try {
        const account = await this.github.account()
        if (account.login.toLowerCase() !== project.autoSync.account.toLowerCase()) throw new WorkspaceError('accountChanged')
        let state = await this.git.status(project)
        if (state.branch !== project.autoSync.branch) throw new WorkspaceError('branchChanged')
        if (state.conflicted) throw new WorkspaceError('conflict')
        if (await this.git.hasStaged(project)) throw new WorkspaceError('stagedChanges')
        report('checkingRemote')
        state = await this.git.fetch(project)
        if (state.behind > 0) throw new WorkspaceError('remoteChanged')
        const paths = [...new Set(state.changes.filter(change => !change.blocked).flatMap(change => change.paths))]
        if (paths.length > 100) throw new WorkspaceError('tooManyChanges')
        if (paths.length) {
          report('committing')
          const preview = await this.preview(fullName, paths)
          state = await this.withScratch(path => this.git.commit(project, preview, `dsh auto commit: ${preview.message}`, githubIdentity(account), path, true))
          this.previews.delete(preview.id)
        }
        if (state.ahead > 0) { report('pushing'); state = await this.git.push(project, state.head) }
        project.autoSync = { ...project.autoSync, lastSyncAt: Date.now() }
        delete project.autoSync.error
      } catch (error) {
        if (!this.lifetime.signal.aborted && !abort.aborted && project.autoSync) project.autoSync.error = error instanceof WorkspaceError ? error.code : 'commandFailed'
        throw error
      } finally {
        const current = await this.readStore()
        await this.writeProjects(current.projects.map(item => projectKey(item) === project.fullName ? project : item))
        this.nextSync.set(project.fullName, Date.now() + project.autoSync!.intervalMinutes * 60_000)
      }
    })))
  }
  /** The timer only dispatches opted-in projects; failed policies stay paused. */
  async tick(now = Date.now()): Promise<void> {
    if (this.stopped) return
    await this.ensureRoot()
    const { projects } = await this.readStore()
    for (const project of projects) {
      const config = project.autoSync
      if (!config?.enabled || config.error || !project.workspaceId) continue
      const due = this.nextSync.get(project.fullName) ?? (config.lastSyncAt ? config.lastSyncAt + config.intervalMinutes * 60_000 : now)
      if (due > now || this.tasks.list().some(task => ['running', 'cancelling'].includes(task.status))) continue
      this.nextSync.set(project.fullName, now + config.intervalMinutes * 60_000)
      this.startSync(project.fullName)
      break
    }
  }
  private schedule(): void {
    this.timer = setTimeout(() => {
      const job = this.tick()
      this.jobs.add(job)
      void job.catch(() => { /* Local storage errors are surfaced by page requests. */ }).finally(() => {
        this.jobs.delete(job)
        if (!this.stopped) this.schedule()
      })
    }, 30_000)
    this.timer.unref?.()
  }
}
