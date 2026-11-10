import { AsyncLocalStorage } from 'node:async_hooks'
import { createHash, randomUUID } from 'node:crypto'
import { lstat, mkdir, mkdtemp, open, readFile, readdir, realpath, rename, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { z } from 'zod'
import { Git } from './git.js'
import { GitHub, repositoryName } from './github.js'
import { commandEnvironment, execute, type Execute } from './process.js'
import { Tasks } from './tasks.js'
import { EncryptionSupport, encryptionSchema } from './encryption.js'
import { Tools } from './tools.js'
import { errorCodes, WorkspaceError, type Activity, type Encryption, type Preview, type Project, type State, type TaskPhase } from './types.js'

export interface WorkspaceRegistry { create(path: string, title?: string): Promise<{ id: string }> }
const autoSyncSchema = z.strictObject({ enabled: z.boolean(), intervalMinutes: z.number().int().min(1).max(60), branch: z.string().min(1), account: z.string().min(1), lastSyncAt: z.number().optional(), error: z.enum(errorCodes).optional() })
  .transform(({ lastSyncAt, error, ...required }) => ({ ...required, ...(lastSyncAt === undefined ? {} : { lastSyncAt }), ...(error === undefined ? {} : { error }) }))
const projectSchema = z.strictObject({ fullName: repositoryName, path: z.string(), workspaceId: z.string(), account: z.string(), autoSync: autoSyncSchema.optional() })
  .transform(({ autoSync, ...required }) => ({ ...required, ...(autoSync === undefined ? {} : { autoSync }) }))
const storeSchema = z.strictObject({ owner: z.literal('dsh-github-workspace/v1'), projects: z.array(projectSchema).max(1000) })
const empty = z.strictObject({}), repoRequest = z.strictObject({ fullName: repositoryName })
const encryptionFileSchema = z.strictObject({ version: z.literal(1), repositories: z.record(repositoryName, encryptionSchema) })
  .refine(file => Object.keys(file.repositories).length <= 1000 && new Set(Object.keys(file.repositories).map(name => name.toLowerCase())).size === Object.keys(file.repositories).length)
const schemas = {
  state: empty, initialize: empty, beginLogin: empty, cancelLogin: empty, owners: empty, activity: empty,
  configureEncryption: z.strictObject({ fullName: repositoryName, encryption: encryptionSchema.nullable() }),
  encryption: repoRequest,
  repositories: z.strictObject({ page: z.number().int().min(1).max(100), owner: z.strictObject({ login: z.string().max(39).regex(/^[A-Za-z0-9-]*$/), kind: z.enum(['personal', 'organization', 'collaborator']) }).optional() }),
  startOpen: repoRequest, startSync: repoRequest, cancelTask: z.strictObject({ id: z.string().uuid() }),
  configureSync: z.strictObject({ fullName: repositoryName, enabled: z.boolean(), intervalMinutes: z.number().int().min(1).max(60) }),
  open: repoRequest, status: repoRequest, fetch: repoRequest, pull: repoRequest,
  preview: z.strictObject({ fullName: repositoryName, paths: z.array(z.string().min(1).max(4096)).min(1).max(100) }),
  commit: z.strictObject({ id: z.string().uuid(), message: z.string().trim().min(1).max(1000).refine(value => !/[\u0000-\u0008\u000b-\u001f]/u.test(value)) }),
  push: z.strictObject({ fullName: repositoryName, head: z.string().regex(/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/) }),
}

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
  private readonly tools: Tools
  private readonly encryption: EncryptionSupport
  private readonly encryptionFile: string
  private root: string
  private init: Promise<void> | undefined
  private stopped = false
  private constructor(home: string, private readonly registry: WorkspaceRegistry, private readonly scratch: string, private readonly run: Execute) {
    this.root = join(home, 'github-workspace')
    this.encryptionFile = join(home, 'github-workspace.encryption.json')
    this.tools = new Tools(join(this.root, 'tools'), run, () => this.ensureRoot())
    const managedRun: Execute = (command, args, options) => this.tools.run(command, args, options)
    const options = () => ({ env: { ...this.tools.environment(), TMPDIR: scratch }, signal: this.scopes.getStore() ?? this.lifetime.signal })
    this.encryption = new EncryptionSupport(managedRun, options, scratch, join(scratch, 'hooks'))
    this.github = new GitHub(managedRun, options)
    this.git = new Git(managedRun, options, join(scratch, 'hooks'), this.encryption)
  }
  static async create(home: string, registry: WorkspaceRegistry, run: Execute = execute): Promise<WorkspaceService> {
    const scratch = await mkdtemp(join(tmpdir(), 'dsh-github-workspace-'))
    await mkdir(join(scratch, 'hooks'))
    const service = new WorkspaceService(home, registry, scratch, run)
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
          return Object.entries((await this.readEncryption()).repositories).find(([name]) => name.toLowerCase() === fullName.toLowerCase())?.[1] ?? null
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
        case 'startOpen': {
          const { fullName } = schemas.startOpen.parse(payload)
          return this.tasks.start(fullName, 'open', (abort, report) => this.scopes.run(AbortSignal.any([abort, this.lifetime.signal]), () => this.exclusive(() => this.openProject(fullName, report))))
        }
        case 'cancelTask': return this.tasks.cancel(schemas.cancelTask.parse(payload).id)
        case 'configureSync': {
          const input = schemas.configureSync.parse(payload)
          if (!input.enabled) await this.tasks.cancelSync(input.fullName)
          return this.exclusive(() => this.configureSync(input.fullName, input.enabled, input.intervalMinutes))
        }
        case 'startSync': return this.startSync(schemas.startSync.parse(payload).fullName)
        case 'open': return this.exclusive(() => this.openProject(schemas.open.parse(payload).fullName))
        case 'status': return this.git.status(await this.project(schemas.status.parse(payload).fullName))
        case 'fetch': return this.exclusive(async () => this.git.fetch(await this.project(schemas.fetch.parse(payload).fullName)))
        case 'pull': return this.exclusive(async () => this.git.pull(await this.project(schemas.pull.parse(payload).fullName)))
        case 'preview': { const input = schemas.preview.parse(payload); return this.exclusive(() => this.preview(input.fullName, input.paths)) }
        case 'commit': { const input = schemas.commit.parse(payload); return this.exclusive(() => this.commit(input.id, input.message)) }
        case 'push': { const input = schemas.push.parse(payload); return this.exclusive(async () => this.git.push(await this.project(input.fullName), input.head)) }
        default: throw new WorkspaceError('invalidRequest')
      }
    })
    this.jobs.add(job)
    try { return await job } finally { this.jobs.delete(job) }
  }
  private path(fullName: string): string {
    const key = createHash('sha256').update(fullName.toLowerCase()).digest('hex').slice(0, 32)
    return join(this.root, 'projects', key)
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
    if (store.projects.some(project => project.path !== this.path(project.fullName)) || new Set(store.projects.map(project => project.fullName.toLowerCase())).size !== store.projects.length) throw new WorkspaceError('unsafeDirectory')
    const configurations = Object.entries((await this.readEncryption()).repositories)
    return { ...store, projects: store.projects.map(project => {
      const encryption = configurations.find(([name]) => name.toLowerCase() === project.fullName.toLowerCase())?.[1]
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
    return { account, ghReady, gitReady, projects, login: this.github.login ? { ...this.github.login } : null, tools: this.tools.state() }
  }
  private async project(fullName: string): Promise<Project> {
    await this.ensureRoot()
    const project = (await this.readStore()).projects.find(project => project.fullName.toLowerCase() === fullName.toLowerCase())
    if (!project || !project.workspaceId) throw new WorkspaceError('unknownProject')
    return project
  }
  private async openProject(fullName: string, report?: (phase: TaskPhase, progress?: number) => void): Promise<Project> {
    report?.('checking')
    const account = await this.github.account(), repo = await this.github.repository(fullName)
    const projects = (await this.readStore()).projects
    let project = projects.find(project => project.fullName.toLowerCase() === repo.fullName.toLowerCase())
    if (!project) {
      project = { fullName: repo.fullName, path: this.path(repo.fullName), workspaceId: '', account: account.login }
      const encryption = Object.entries((await this.readEncryption()).repositories).find(([name]) => name.toLowerCase() === repo.fullName.toLowerCase())?.[1]
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
        await this.git.clone(stage, project.fullName, join(stage, 'repository'), report)
        try { await lstat(project.path); throw new WorkspaceError('unsafeDirectory') }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
        await rename(join(stage, 'repository'), project.path)
      }
      finally { await rm(stage, { recursive: true, force: true }) }
    }
    await this.git.verify(project)
    report?.('unlocking')
    await this.encryption.unlock(project, (args, options) => this.git.command(project.path, args, options))
    this.scopes.getStore()?.throwIfAborted()
    report?.('registering')
    const workspace = await this.registry.create(project.path, project.fullName)
    project.workspaceId = workspace.id; project.account = account.login
    await this.writeProjects(projects)
    return project
  }
  private async withScratch<T>(work: (path: string) => Promise<T>): Promise<T> {
    const path = await mkdtemp(join(this.scratch, 'review-'))
    try { return await work(path) } finally { await rm(path, { recursive: true, force: true }) }
  }
  private async preview(fullName: string, paths: string[]): Promise<Preview> {
    const project = await this.project(fullName), state = await this.git.status(project)
    const staged = await this.withScratch(path => this.git.stage(project, paths, path))
    for (const [id, preview] of this.previews) if (preview.expiresAt < Date.now()) this.previews.delete(id)
    if (this.previews.size >= 20) this.previews.delete(this.previews.keys().next().value!)
    const preview: Preview = { id: randomUUID(), fullName: project.fullName, head: state.head, tree: staged.tree, paths: [...paths],
      diff: staged.diff, message: `Update ${paths.length} file${paths.length === 1 ? '' : 's'} in ${project.fullName}`, expiresAt: Date.now() + 10 * 60_000 }
    this.previews.set(preview.id, preview)
    return preview
  }
  private async commit(id: string, message: string): Promise<unknown> {
    const preview = this.previews.get(id)
    if (!preview || preview.expiresAt < Date.now()) throw new WorkspaceError('stalePreview')
    const project = await this.project(preview.fullName), account = await this.github.account()
    const result = await this.withScratch(path => this.git.commit(project, preview, message, account, path))
    this.previews.delete(id)
    return result
  }
  private async activity(): Promise<Activity> {
    await this.ensureRoot()
    return { projects: (await this.readStore()).projects, tasks: this.tasks.list(), login: this.github.login ? { ...this.github.login } : null, tools: this.tools.state() }
  }
  private async configureEncryption(fullName: string, encryption: Encryption | null): Promise<Project> {
    const store = await this.readStore()
    let project = store.projects.find(project => project.fullName.toLowerCase() === fullName.toLowerCase())
    if (!project) {
      const account = await this.github.account(), repo = await this.github.repository(fullName)
      project = { fullName: repo.fullName, path: this.path(repo.fullName), account: account.login, workspaceId: '' }
      try { await lstat(project.path); throw new WorkspaceError('unsafeDirectory') } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
      store.projects.push(project)
      await this.writeProjects(store.projects)
    }
    const config = await this.readEncryption()
    for (const name of Object.keys(config.repositories)) if (name.toLowerCase() === fullName.toLowerCase()) delete config.repositories[name]
    if (encryption) config.repositories[project.fullName] = encryption
    const temporary = this.encryptionFile + '.' + randomUUID() + '.tmp'
    const file = await open(temporary, 'wx', 0o600)
    try { await file.writeFile(JSON.stringify(config, null, 2) + '\n'); await file.sync() } finally { await file.close() }
    try { await rename(temporary, this.encryptionFile) } finally { await rm(temporary, { force: true }) }
    if (encryption) project.encryption = encryption; else delete project.encryption
    if (project.autoSync) project.autoSync = { ...project.autoSync, enabled: false }
    await this.writeProjects(store.projects)
    for (const [id, preview] of this.previews) if (preview.fullName === project.fullName) this.previews.delete(id)
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
    await this.writeProjects(store.projects.map(item => item.fullName === project.fullName ? project : item))
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
          state = await this.withScratch(path => this.git.commit(project, preview, preview.message, account, path, true))
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
        await this.writeProjects(current.projects.map(item => item.fullName === project.fullName ? project : item))
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
