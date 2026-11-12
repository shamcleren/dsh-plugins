import { randomUUID } from 'node:crypto'
import { chmod, copyFile, lstat, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { WorkspaceService } from '../src/service.js'
import { commandEnvironment, execute, type CommandOptions, type Execute } from '../src/process.js'
import { WorkspaceError, type Activity, type Preview, type Project, type ProjectStatus, type State, type Task } from '../src/types.js'

const disposals: Array<() => Promise<void>> = []
afterEach(async () => { for (const dispose of disposals.splice(0).reverse()) await dispose() })

async function fixture(empty = false, encrypted: boolean | 'gpg' = false) {
  const base = await realpath(await mkdtemp(join(tmpdir(), 'github-workspace-test-')))
  disposals.push(() => rm(base, { recursive: true, force: true }))
  const bare = join(base, 'remote.git'), seed = join(base, 'seed'), home = join(base, 'home')
  await mkdir(seed); await mkdir(home)
  const isolation = { HOME: home, XDG_CONFIG_HOME: join(home, '.config'), GNUPGHOME: join(home, '.gnupg'), GH_CONFIG_DIR: join(home, '.gh'), GH_TOKEN: '', GITHUB_TOKEN: '' }
  const env = { ...commandEnvironment(), ...isolation, GIT_AUTHOR_NAME: 'Fixture', GIT_COMMITTER_NAME: 'Fixture', GIT_AUTHOR_EMAIL: 'fixture@example.invalid', GIT_COMMITTER_EMAIL: 'fixture@example.invalid' }
  async function git(cwd: string, ...args: string[]) {
    const result = await execute('git', args, { cwd, env })
    if (result.code !== 0) throw new Error(result.stderr)
    return result.stdout
  }
  await git(base, 'init', '--bare', '--initial-branch=main', bare)
  await git(seed, 'init', '--initial-branch=main')
  const keyFile = join(base, 'fixture.key')
  if (encrypted) {
    if (encrypted === 'gpg') {
      isolation.GNUPGHOME = await mkdtemp(join(process.platform === 'darwin' ? '/private/tmp' : tmpdir(), 'ghw-gpg-'))
      env.GNUPGHOME = isolation.GNUPGHOME
      disposals.push(async () => {
        await execute('gpgconf', ['--homedir', isolation.GNUPGHOME, '--kill', 'gpg-agent'], { env })
        await rm(isolation.GNUPGHOME, { recursive: true, force: true })
      })
      const generated = await execute('gpg', ['--batch', '--pinentry-mode', 'loopback', '--passphrase', '', '--quick-generate-key', 'Fixture <fixture@example.invalid>', 'default', 'default', '0'], { env, timeoutMs: 30_000 })
      expect(generated.code, generated.stderr).toBe(0)
    }
    for (const args of [['init'], ['export-key', keyFile]]) {
      const result = await execute('git-crypt', args, { cwd: seed, env })
      if (result.code !== 0) throw new Error('Fixture git-crypt setup failed')
    }
    await chmod(keyFile, 0o600)
    if (encrypted === 'gpg') expect((await execute('git-crypt', ['add-gpg-user', '--no-commit', 'fixture@example.invalid'], { cwd: seed, env })).code).toBe(0)
    await mkdir(join(seed, 'private'))
    await writeFile(join(seed, '.gitattributes'), 'private/** filter=git-crypt diff=git-crypt\n')
    await writeFile(join(seed, 'private/note.md'), 'synthetic private fixture\n')
    await writeFile(join(home, 'github-workspace.encryption.json'), JSON.stringify({ version: 1, repositories: { 'demo/project': { mode: 'git-crypt', ...(encrypted === 'gpg' ? { keySource: 'gpg' } : { keySource: 'file', keyFile }) } } }), { mode: 0o600 })
  }
  if (!empty) {
    await writeFile(join(seed, 'a.txt'), 'original a\n'); await writeFile(join(seed, 'b.txt'), 'original b\n')
    await git(seed, 'add', '.'); await git(seed, 'commit', '-m', 'Initial fixture'); await git(seed, 'push', bare, 'HEAD:refs/heads/main')
  }
  const commands: string[][] = []
  const control: { account: string; before?: (args: string[], options: CommandOptions | undefined) => Promise<void> } = { account: 'fixture' }
  const run: Execute = async (command, args, options) => {
    commands.push([command, ...args])
    if (command === 'gh') {
      let value: unknown = null
      if (args[0] === '--version') return { code: 0, stdout: 'gh version 2.103.3 (fixture)', stderr: '' }
      if (args.at(-1) === '/user') value = { id: 7, login: control.account }
      else if (args.at(-1)?.startsWith('/user/orgs')) value = [{ login: 'demo' }]
      else if (args.at(-1)?.startsWith('/user/repos')) value = [{ full_name: 'demo/project', private: true, permissions: { push: true }, default_branch: 'main' }]
      else if (args.at(-1) === '/repos/demo/project') value = { full_name: 'demo/project', private: true, permissions: { push: true }, default_branch: 'main' }
      else throw new Error('Unexpected GitHub call')
      return { code: 0, stdout: JSON.stringify(value), stderr: '' }
    }
    const transport = args.findIndex(arg => ['clone', 'fetch', 'push', 'ls-remote'].includes(arg))
    // Production always uses HTTPS github.com. Only this fixture rewrites the
    // transport to its private bare repository; no real account is consulted.
    if (transport >= 0) args = [...args.slice(0, transport), '-c', 'protocol.file.allow=always', '-c', 'url.file://' + bare + '.insteadOf=https://github.com/demo/project.git', ...args.slice(transport)]
    await control.before?.(args, options)
    return execute(command, args, { ...options, env: { ...options?.env, ...isolation } })
  }
  const registered = new Map<string, string>()
  const registry = { create: vi.fn(async (path: string) => {
    const id = registered.get(path) ?? randomUUID(); registered.set(path, id); return { id }
  }) }
  const service = await WorkspaceService.create(home, registry, run)
  disposals.push(() => service.stop())
  const call = <T>(method: string, payload: unknown = {}) => service.request(method, payload) as Promise<T>
  const project = await call<Project>('open', { fullName: 'demo/project' })
  const status = () => call<ProjectStatus>('status', { fullName: project.fullName })
  const preview = (paths: string[]) => call<Preview>('preview', { fullName: project.fullName, paths })
  const remoteChange = async () => {
    await writeFile(join(seed, 'remote.txt'), randomUUID())
    await git(seed, 'add', 'remote.txt'); await git(seed, 'commit', '-m', 'Remote update'); await git(seed, 'push', bare, 'HEAD:refs/heads/main')
  }
  const finished = async (id: string) => {
    let task: Task | undefined
    await vi.waitFor(async () => {
      task = (await call<Activity>('activity')).tasks.find(task => task.id === id)
      expect(task && ['complete', 'failed', 'cancelled'].includes(task.status)).toBe(true)
    }, { timeout: 10_000, interval: 100 })
    return task!
  }
  return { base, bare, seed, home, service, call, git, registry, project, status, preview, commands, remoteChange, control, finished, keyFile }
}

it('unlocks configured git-crypt repositories and keeps manual and automatic remote blobs encrypted', async () => {
  const f = await fixture(false, true)
  expect(await readFile(join(f.project.path, 'private/note.md'), 'utf8')).toBe('synthetic private fixture\n')
  await writeFile(join(f.project.path, 'private/note.md'), 'manual private fixture\n')
  const review = await f.preview(['private/note.md'])
  const state = await f.call<ProjectStatus>('commit', { id: review.id, message: 'Fixture update' })
  await f.call('push', { fullName: f.project.fullName, head: state.head })
  const blob = await f.git(f.base, '--git-dir=' + f.bare, 'show', 'main:private/note.md')
  expect(blob.startsWith('\0GITCRYPT\0')).toBe(true)
  expect(blob).not.toContain('manual private fixture')
  await f.call('configureSync', { fullName: f.project.fullName, enabled: true, intervalMinutes: 5 })
  await writeFile(join(f.project.path, 'private/note.md'), 'automatic private fixture\n')
  const task = await f.call<Task>('startSync', { fullName: f.project.fullName })
  expect(await f.finished(task.id)).toMatchObject({ status: 'complete' })
  const updated = await f.git(f.base, '--git-dir=' + f.bare, 'show', 'main:private/note.md')
  expect(updated.startsWith('\0GITCRYPT\0')).toBe(true)
  expect(updated).not.toContain('automatic private fixture')
  expect(await readFile(join(f.project.path, 'private/note.md'), 'utf8')).toBe('automatic private fixture\n')
  await f.git(f.seed, 'fetch', f.bare, 'main')
  await f.git(f.seed, 'reset', '--hard', 'FETCH_HEAD')
  expect(await readFile(join(f.seed, 'private/note.md'), 'utf8')).toBe('automatic private fixture\n')
}, 30_000)

it('unlocks through an isolated authorized GPG keyring without a symmetric key setting', async () => {
  const f = await fixture(false, 'gpg')
  expect(await readFile(join(f.project.path, 'private/note.md'), 'utf8')).toBe('synthetic private fixture\n')
  expect(f.project.encryption).toMatchObject({ mode: 'git-crypt', keySource: 'gpg' })
}, 30_000)

it('recovers unchanged ciphertext after an interrupted unlock while preserving plaintext edits', async () => {
  const f = await fixture(false, true)
  const cipher = await execute('git', ['cat-file', 'blob', 'HEAD:private/note.md'], { cwd: f.project.path, env: commandEnvironment(), captureBinary: true })
  expect(cipher.stdoutBytes).toBeDefined()
  await writeFile(join(f.project.path, 'private/note.md'), cipher.stdoutBytes!)
  await writeFile(join(f.project.path, 'a.txt'), 'preserve edit\n')
  await expect(f.preview(['private/note.md'])).rejects.toMatchObject({ code: 'encryptionRequired' })
  await f.call('open', { fullName: f.project.fullName })
  expect(await readFile(join(f.project.path, 'private/note.md'), 'utf8')).toBe('synthetic private fixture\n')
  expect(await readFile(join(f.project.path, 'a.txt'), 'utf8')).toBe('preserve edit\n')
}, 30_000)

it('refuses registration and commits while locked, preserves ciphertext on a wrong key, and permits correction', async () => {
  const f = await fixture(false, true)
  await f.call('configureEncryption', { fullName: f.project.fullName, encryption: null })
  await rm(f.project.path, { recursive: true })
  f.registry.create.mockClear()
  await expect(f.call('open', { fullName: f.project.fullName })).rejects.toMatchObject({ code: 'encryptionRequired' })
  expect(f.registry.create).not.toHaveBeenCalled()
  const ciphertext = await readFile(join(f.project.path, 'private/note.md'))
  expect(ciphertext.subarray(0, 10).toString()).toBe('\0GITCRYPT\0')
  await expect(f.preview(['private/note.md'])).rejects.toMatchObject({ code: 'encryptionRequired' })
  const wrongRepo = join(f.base, 'wrong-repo'), wrongKey = join(f.base, 'wrong.key')
  await mkdir(wrongRepo); await f.git(wrongRepo, 'init')
  for (const args of [['init'], ['export-key', wrongKey]]) expect((await execute('git-crypt', args, { cwd: wrongRepo, env: commandEnvironment() })).code).toBe(0)
  await chmod(wrongKey, 0o600)
  await f.call('configureEncryption', { fullName: f.project.fullName, encryption: { mode: 'git-crypt', keySource: 'file', keyFile: wrongKey } })
  await expect(f.call('open', { fullName: f.project.fullName })).rejects.toMatchObject({ code: 'encryptionKey' })
  expect(await readFile(join(f.project.path, 'private/note.md'))).toEqual(ciphertext)
  expect(f.registry.create).not.toHaveBeenCalled()
  await f.call('configureEncryption', { fullName: f.project.fullName, encryption: { mode: 'git-crypt', keySource: 'file', keyFile: f.keyFile } })
  expect((await f.call<Project>('open', { fullName: f.project.fullName })).workspaceId).toBe(f.project.workspaceId)
  expect(await readFile(join(f.project.path, 'private/note.md'), 'utf8')).toBe('synthetic private fixture\n')
}, 30_000)

it('rejects plaintext in outgoing history even when a later commit repairs it and local remote refs are forged', async () => {
  const f = await fixture(false, true), before = (await f.status()).head
  await writeFile(join(f.project.path, 'private/note.md'), 'plaintext must never be pushed\n')
  await f.git(f.project.path, '-c', 'filter.git-crypt.clean=', '-c', 'filter.git-crypt.required=false', 'add', 'private/note.md')
  await f.git(f.project.path, 'commit', '-m', 'Unsafe fixture commit')
  const unsafe = (await f.git(f.project.path, 'rev-parse', 'HEAD')).trim()
  await f.git(f.project.path, 'add', 'private/note.md')
  await f.git(f.project.path, 'commit', '-m', 'Repair fixture encryption')
  await f.git(f.project.path, 'update-ref', 'refs/remotes/origin/main', unsafe)
  const state = await f.status()
  await expect(f.call('push', { fullName: f.project.fullName, head: state.head })).rejects.toMatchObject({ code: 'encryptionUnsafe' })
  expect((await f.git(f.base, '--git-dir=' + f.bare, 'rev-parse', 'main')).trim()).toBe(before)
}, 30_000)

it('rejects removing encryption rules and disables automatic sync when encryption settings change', async () => {
  const f = await fixture(false, true)
  await f.call('configureSync', { fullName: f.project.fullName, enabled: true, intervalMinutes: 5 })
  await writeFile(join(f.project.path, '.gitattributes'), '')
  await writeFile(join(f.project.path, 'private/note.md'), 'must remain encrypted\n')
  await expect(f.preview(['.gitattributes', 'private/note.md'])).rejects.toMatchObject({ code: 'encryptionUnsafe' })
  const project = await f.call<Project>('configureEncryption', { fullName: f.project.fullName, encryption: null })
  expect(project.autoSync?.enabled).toBe(false)
  await expect(f.status()).rejects.toMatchObject({ code: 'encryptionRequired' })
  await expect(f.call('configureEncryption', { fullName: f.project.fullName, encryption: { mode: 'git-crypt', keySource: 'file', keyFile: 'raw-key-material' } })).rejects.toMatchObject({ code: 'invalidRequest' })
}, 30_000)

it('rejects a forged encryption header in outgoing blobs after checking its authentication', async () => {
  const f = await fixture(false, true), before = (await f.status()).head
  await writeFile(join(f.project.path, 'private/z-forged.bin'), Buffer.concat([Buffer.from('\0GITCRYPT\0'), Buffer.alloc(12), Buffer.from('forged plaintext fixture')]))
  await f.git(f.project.path, '-c', 'filter.git-crypt.clean=', '-c', 'filter.git-crypt.required=false', 'add', 'private/z-forged.bin')
  await f.git(f.project.path, 'commit', '-m', 'Forged fixture ciphertext')
  const state = await f.status()
  await expect(f.call('push', { fullName: f.project.fullName, head: state.head })).rejects.toMatchObject({ code: 'encryptionUnsafe' })
  expect((await f.git(f.base, '--git-dir=' + f.bare, 'rev-parse', 'main')).trim()).toBe(before)
}, 30_000)

it('keeps the remote encryption policy across separate rule-narrowing and plaintext commits', async () => {
  const f = await fixture(false, true), before = (await f.status()).head
  await writeFile(join(f.project.path, '.gitattributes'), 'private/note.md filter=git-crypt diff=git-crypt\n')
  await f.git(f.project.path, 'add', '.gitattributes')
  await f.git(f.project.path, 'commit', '-m', 'Narrow fixture policy')
  await writeFile(join(f.project.path, 'private/z-plain.md'), 'must not cross the old policy\n')
  await f.git(f.project.path, 'add', 'private/z-plain.md')
  await f.git(f.project.path, 'commit', '-m', 'Plaintext after policy change')
  const state = await f.status()
  await expect(f.call('push', { fullName: f.project.fullName, head: state.head })).rejects.toMatchObject({ code: 'encryptionUnsafe' })
  expect((await f.git(f.base, '--git-dir=' + f.bare, 'rev-parse', 'main')).trim()).toBe(before)
}, 30_000)

it('updates native Git filters when the configured binary changes and detects its removal', async () => {
  const f = await fixture(false, true)
  const source = f.commands.find(([command, argument]) => command?.endsWith('/git-crypt') && argument === '--version')![0]!
  const binaryPath = join(f.base, 'alternate git-crypt')
  await copyFile(source, binaryPath); await chmod(binaryPath, 0o700)
  await f.call('configureEncryption', { fullName: f.project.fullName, encryption: { mode: 'git-crypt', keySource: 'file', keyFile: f.keyFile, binaryPath } })
  await f.call('open', { fullName: f.project.fullName })
  expect(await f.git(f.project.path, 'config', '--get', 'filter.git-crypt.clean')).toContain(binaryPath)
  await rm(binaryPath)
  await expect(f.status()).rejects.toMatchObject({ code: 'cryptMissing' })
}, 30_000)

it('keeps activity responsive while opening in the background and releases cancellation ownership', async () => {
  const f = await fixture()
  await rm(f.project.path, { recursive: true })
  let entered!: () => void
  const started = new Promise<void>(resolve => { entered = resolve })
  f.control.before = async (args, options) => {
    if (!args.includes('clone')) return
    entered()
    await new Promise<void>((_resolve, reject) => {
      options?.signal?.addEventListener('abort', () => reject(new WorkspaceError('stopped')), { once: true })
    })
  }
  const task = await f.call<Task>('startOpen', { fullName: f.project.fullName })
  expect(task.status).toBe('running')
  await started
  const beforePoll = f.commands.length
  expect((await f.call<Activity>('activity')).tasks[0]?.phase).toBe('cloning')
  expect(f.commands.length).toBe(beforePoll)
  expect((await f.call<Task>('cancelTask', { id: task.id })).status).toBe('cancelling')
  expect((await f.finished(task.id)).status).toBe('cancelled')
  await expect(lstat(join(f.home, 'github-workspace/.operation.lock'))).rejects.toMatchObject({ code: 'ENOENT' })
  delete f.control.before
  expect((await f.call<Project>('open', { fullName: f.project.fullName })).workspaceId).toBe(f.project.workspaceId)
})

it('keeps existing projects manual and only dispatches an opted-in project for automatic commit and push', async () => {
  const f = await fixture()
  await f.service.tick(Date.now() + 3600_000)
  expect((await f.call<Activity>('activity')).tasks).toEqual([])
  const policy = await f.call<Project>('configureSync', { fullName: f.project.fullName, enabled: true, intervalMinutes: 5 })
  expect(policy.autoSync).toMatchObject({ enabled: true, branch: 'main', account: 'fixture', intervalMinutes: 5 })
  await writeFile(join(f.project.path, 'a.txt'), 'automatically saved\n')
  await writeFile(join(f.project.path, '.env'), 'never-upload\n')
  await f.service.tick(Date.now() + 6 * 60_000)
  const task = (await f.call<Activity>('activity')).tasks[0]!
  expect((await f.finished(task.id)).status).toBe('complete')
  expect(await f.git(f.base, '--git-dir=' + f.bare, 'show', 'main:a.txt')).toBe('automatically saved\n')
  expect(await f.git(f.base, '--git-dir=' + f.bare, 'log', '-1', '--format=%s', 'main')).toBe('dsh auto commit: Update 1 file in demo/project\n')
  expect(await f.git(f.base, '--git-dir=' + f.bare, 'ls-tree', '--name-only', 'main')).not.toContain('.env')
  expect((await f.call<Activity>('activity')).projects[0]?.autoSync?.lastSyncAt).toEqual(expect.any(Number))
}, 15_000)

it.each(['signing', 'hooks', 'included'])('keeps managed saves and automatic sync isolated from global %s policy', async policy => {
  const f = await fixture(), globalConfig = join(f.home, '.gitconfig'), hooks = join(f.home, 'global-hooks')
  await mkdir(hooks)
  for (const name of ['pre-commit', 'pre-push']) {
    const path = join(hooks, name)
    await writeFile(path, '#!/bin/sh\nexit 1\n'); await chmod(path, 0o700)
  }
  const policyConfig = policy === 'included' ? join(f.home, 'included.gitconfig') : globalConfig
  if (policy !== 'hooks') await f.git(f.home, 'config', '--file', policyConfig, 'commit.gpgSign', 'true')
  if (policy !== 'signing') await f.git(f.home, 'config', '--file', policyConfig, 'core.hooksPath', hooks)
  if (policy === 'included') await f.git(f.home, 'config', '--file', globalConfig, 'include.path', policyConfig)
  const originalConfig = await readFile(globalConfig), originalPolicy = await readFile(policyConfig)
  await writeFile(join(f.project.path, 'a.txt'), 'manual save under host policy\n')
  const review = await f.preview(['a.txt'])
  const saved = await f.call<ProjectStatus>('commit', { id: review.id, message: 'My manual save' })
  await f.call('push', { fullName: f.project.fullName, head: saved.head })
  expect(await f.git(f.base, '--git-dir=' + f.bare, 'log', '-1', '--format=%s', 'main')).toBe('My manual save\n')
  await f.call('configureSync', { fullName: f.project.fullName, enabled: true, intervalMinutes: 5 })
  await writeFile(join(f.project.path, 'a.txt'), 'automatic save under host policy\n')
  const task = await f.call<Task>('startSync', { fullName: f.project.fullName })
  expect(await f.finished(task.id)).toMatchObject({ status: 'complete' })
  expect(await f.git(f.base, '--git-dir=' + f.bare, 'show', 'main:a.txt')).toBe('automatic save under host policy\n')
  expect(await f.git(f.base, '--git-dir=' + f.bare, 'log', '-1', '--format=%s', 'main')).toBe('dsh auto commit: Update 1 file in demo/project\n')
  expect(await readFile(globalConfig)).toEqual(originalConfig)
  expect(await readFile(policyConfig)).toEqual(originalPolicy)
}, 15_000)

it.each(['staged', 'remote', 'account', 'branch', 'hook', 'hooksPath', 'signing'])('pauses automatic sync on %s changes without overwriting work', async reason => {
  const f = await fixture(), head = (await f.status()).head
  await f.call('configureSync', { fullName: f.project.fullName, enabled: true, intervalMinutes: 5 })
  await writeFile(join(f.project.path, 'a.txt'), 'preserve this work\n')
  if (reason === 'staged') await f.git(f.project.path, 'add', 'a.txt')
  if (reason === 'remote') await f.remoteChange()
  if (reason === 'account') f.control.account = 'other-user'
  if (reason === 'branch') await f.git(f.project.path, 'checkout', '-b', 'another')
  if (reason === 'hook') { const hook = join(f.project.path, '.git/hooks/pre-commit'); await writeFile(hook, '#!/bin/sh\nexit 1\n'); await chmod(hook, 0o700) }
  if (reason === 'hooksPath') await f.git(f.project.path, 'config', 'core.hooksPath', '.project-hooks')
  if (reason === 'signing') await f.git(f.project.path, 'config', 'commit.gpgSign', 'true')
  const task = await f.call<Task>('startSync', { fullName: f.project.fullName })
  const expected = { staged: 'stagedChanges', remote: 'remoteChanged', account: 'accountChanged', branch: 'branchChanged', hook: 'projectCommitFlow', hooksPath: 'projectCommitFlow', signing: 'projectCommitFlow' }[reason]
  expect(await f.finished(task.id)).toMatchObject({ status: 'failed', error: expected })
  const activity = await f.call<Activity>('activity')
  expect(activity.projects[0]?.autoSync?.error).toBe(expected)
  await f.service.tick(Date.now() + 3600_000)
  expect((await f.call<Activity>('activity')).tasks).toHaveLength(1)
  expect((await f.status()).head).toBe(head)
  expect(await readFile(join(f.project.path, 'a.txt'), 'utf8')).toBe('preserve this work\n')
}, 15_000)

it('disabling automatic sync cancels its active network operation before saving manual mode', async () => {
  const f = await fixture()
  await f.call('configureSync', { fullName: f.project.fullName, enabled: true, intervalMinutes: 5 })
  let entered!: () => void
  const started = new Promise<void>(resolve => { entered = resolve })
  f.control.before = async (args, options) => {
    if (!args.includes('fetch')) return
    entered()
    await new Promise<void>((_resolve, reject) => options?.signal?.addEventListener('abort', () => reject(new WorkspaceError('stopped')), { once: true }))
  }
  const task = await f.call<Task>('startSync', { fullName: f.project.fullName })
  await started
  const project = await f.call<Project>('configureSync', { fullName: f.project.fullName, enabled: false, intervalMinutes: 5 })
  expect(project.autoSync?.enabled).toBe(false)
  expect((await f.finished(task.id)).status).toBe('cancelled')
})

it('can disable automatic sync even when the project directory is missing', async () => {
  const f = await fixture()
  await f.call('configureSync', { fullName: f.project.fullName, enabled: true, intervalMinutes: 5 })
  await rm(f.project.path, { recursive: true })
  const commands = f.commands.length
  const project = await f.call<Project>('configureSync', { fullName: f.project.fullName, enabled: false, intervalMinutes: 5 })
  expect(project.autoSync?.enabled).toBe(false)
  expect(f.commands.length).toBe(commands)
  expect((await f.call<Activity>('activity')).projects[0]?.autoSync?.enabled).toBe(false)
})

it('clones a selected private repository once and reuses its registered workspace', async () => {
  const f = await fixture()
  expect(await readFile(join(f.project.path, 'a.txt'), 'utf8')).toBe('original a\n')
  const again = await f.call<Project>('open', { fullName: 'demo/project' })
  expect(again).toEqual(f.project)
  expect(f.commands.filter(command => command.includes('clone'))).toHaveLength(1)
  expect(f.registry.create).toHaveBeenCalledWith(f.project.path, 'demo/project')
  expect((await f.call<State>('state')).account?.login).toBe('fixture')
  expect(await f.call('repositories', { page: 1 })).toEqual([{ fullName: 'demo/project', private: true, writable: true, defaultBranch: 'main' }])
  expect((await f.status()).changes).toEqual([])
})

it('previews without touching the real index and commits only the reviewed tree, retaining other staged changes', async () => {
  const f = await fixture(), index = join(f.project.path, '.git/index')
  await writeFile(join(f.project.path, 'a.txt'), 'reviewed a\n')
  await writeFile(join(f.project.path, 'b.txt'), 'unrelated staged b\n')
  await writeFile(join(f.project.path, '.env'), 'FIXTURE_PRIVATE=do-not-push\n')
  await f.git(f.project.path, 'add', 'b.txt')
  const originalIndex = await readFile(index)
  const review = await f.preview(['a.txt'])
  expect(review.diff).toContain('+reviewed a'); expect(review.diff).not.toContain('FIXTURE_PRIVATE')
  expect(await readFile(index)).toEqual(originalIndex)
  const saved = await f.call<ProjectStatus>('commit', { id: review.id, message: 'Save reviewed A' })
  expect(await f.git(f.project.path, 'show', 'HEAD:a.txt')).toBe('reviewed a\n')
  expect(await f.git(f.project.path, 'show', 'HEAD:b.txt')).toBe('original b\n')
  expect(await f.git(f.project.path, 'diff', '--cached', '--name-only')).toBe('b.txt\n')
  expect(saved.ahead).toBe(1)
  await f.call('push', { fullName: f.project.fullName, head: saved.head })
  expect(await f.git(f.base, '--git-dir=' + f.bare, 'show', 'main:a.txt')).toBe('reviewed a\n')
  expect(await f.git(f.base, '--git-dir=' + f.bare, 'ls-tree', '--name-only', 'main')).not.toContain('.env')
  expect((await f.status()).ahead).toBe(0)
})

it.each(['hook', 'hooksPath', 'signing', 'included'])('preserves the configured %s commit workflow', async policy => {
  const f = await fixture(), before = (await f.status()).head
  await writeFile(join(f.project.path, 'a.txt'), 'policy protected change\n')
  const review = await f.preview(['a.txt'])
  if (policy === 'hook') {
    await writeFile(join(f.project.path, '.git/hooks/pre-commit'), '#!/bin/sh\nexit 1\n')
    await chmod(join(f.project.path, '.git/hooks/pre-commit'), 0o700)
  } else if (policy === 'hooksPath') await f.git(f.project.path, 'config', 'core.hooksPath', '.project-hooks')
  else if (policy === 'included') {
    const included = join(f.home, 'project.gitconfig')
    await writeFile(included, '[commit]\n\tgpgSign\n')
    await f.git(f.project.path, 'config', 'include.path', included)
  } else await f.git(f.project.path, 'config', 'commit.gpgSign', 'true')
  await expect(f.call('commit', { id: review.id, message: 'Protected change' })).rejects.toMatchObject({ code: 'projectCommitFlow' })
  expect((await f.status()).head).toBe(before)
})

it.each(['hook', 'hooksPath'])('does not bypass a project push workflow configured through %s', async policy => {
  const f = await fixture(), original = (await f.git(f.base, '--git-dir=' + f.bare, 'rev-parse', 'main')).trim()
  await writeFile(join(f.project.path, 'a.txt'), 'local change\n')
  const review = await f.preview(['a.txt'])
  const saved = await f.call<ProjectStatus>('commit', { id: review.id, message: 'Local change' })
  if (policy === 'hook') {
    const hook = join(f.project.path, '.git/hooks/pre-push')
    await writeFile(hook, '#!/bin/sh\nexit 1\n'); await chmod(hook, 0o700)
  } else await f.git(f.project.path, 'config', 'core.hooksPath', '.project-hooks')
  await expect(f.call('push', { fullName: f.project.fullName, head: saved.head })).rejects.toMatchObject({ code: 'projectPushFlow' })
  expect((await f.git(f.base, '--git-dir=' + f.bare, 'rev-parse', 'main')).trim()).toBe(original)
})

it('rejects stale previews and sensitive paths without changing HEAD or the real index', async () => {
  const f = await fixture()
  await writeFile(join(f.project.path, 'new.txt'), 'before review\n')
  const before = await f.status(), index = await readFile(join(f.project.path, '.git/index'))
  const review = await f.preview(['new.txt'])
  await writeFile(join(f.project.path, 'new.txt'), 'edited after review\n')
  await expect(f.call('commit', { id: review.id, message: 'Should fail' })).rejects.toMatchObject({ code: 'stalePreview' })
  for (const path of ['../escape', '.git/config', '.env', '.credentials.yaml', 'id_rsa']) {
    await expect(f.preview([path])).rejects.toMatchObject({ code: 'sensitiveFile' })
  }
  expect((await f.status()).head).toBe(before.head)
  expect(await readFile(join(f.project.path, '.git/index'))).toEqual(index)
})

it('fast-forwards a clean project and refuses dirty pull or a non-fast-forward push', async () => {
  const f = await fixture()
  await f.remoteChange()
  expect((await f.call<ProjectStatus>('fetch', { fullName: f.project.fullName })).behind).toBe(1)
  await f.call('pull', { fullName: f.project.fullName })
  expect(await readFile(join(f.project.path, 'remote.txt'), 'utf8')).toBe(await readFile(join(f.seed, 'remote.txt'), 'utf8'))
  await writeFile(join(f.project.path, 'a.txt'), 'local saved change\n')
  await expect(f.call('pull', { fullName: f.project.fullName })).rejects.toMatchObject({ code: 'dirty' })
  const review = await f.preview(['a.txt'])
  const local = await f.call<ProjectStatus>('commit', { id: review.id, message: 'Local update' })
  await f.remoteChange()
  const remoteHead = (await f.git(f.base, '--git-dir=' + f.bare, 'rev-parse', 'main')).trim()
  await expect(f.call('push', { fullName: f.project.fullName, head: local.head })).rejects.toMatchObject({ code: 'pushFailed' })
  expect((await f.git(f.base, '--git-dir=' + f.bare, 'rev-parse', 'main')).trim()).toBe(remoteHead)
  await expect(f.call('pull', { fullName: f.project.fullName })).rejects.toMatchObject({ code: 'conflict' })
  expect((await f.status()).head).toBe(local.head)
})

it('creates and pushes the first commit of an empty repository', async () => {
  const f = await fixture(true)
  await mkdir(join(f.project.path, 'nested')); await writeFile(join(f.project.path, 'nested/file'), 'first\n')
  const review = await f.preview(['nested/file'])
  const first = await f.call<ProjectStatus>('commit', { id: review.id, message: 'Initial commit' })
  await f.call('push', { fullName: f.project.fullName, head: first.head })
  expect(await f.git(f.base, '--git-dir=' + f.bare, 'show', 'main:nested/file')).toBe('first\n')
  expect((await f.status()).changes).toEqual([])
})

it('commits both paths of a staged rename', async () => {
  const f = await fixture()
  await mkdir(join(f.project.path, 'nested'))
  await f.git(f.project.path, 'mv', 'a.txt', 'nested/renamed')
  const changes = (await f.status()).changes
  const rename = await f.preview(changes.flatMap(change => change.paths))
  await f.call('commit', { id: rename.id, message: 'Rename file' })
  expect(await f.git(f.project.path, 'show', 'HEAD:nested/renamed')).toBe('original a\n')
  expect((await f.git(f.project.path, 'ls-tree', '-r', '--name-only', 'HEAD')).split('\n')).not.toContain('a.txt')
  expect((await f.status()).changes).toEqual([])
})

it('commits a nested deletion after its parent directory disappears', async () => {
  const f = await fixture()
  await mkdir(join(f.project.path, 'nested')); await writeFile(join(f.project.path, 'nested/file'), 'delete fixture\n')
  await f.git(f.project.path, 'add', 'nested/file'); await f.git(f.project.path, 'commit', '-m', 'Prepare nested fixture')
  await rm(join(f.project.path, 'nested'), { recursive: true })
  const deletion = await f.preview(['nested/file'])
  await f.call('commit', { id: deletion.id, message: 'Delete file' })
  expect((await f.git(f.project.path, 'ls-tree', '-r', '--name-only', 'HEAD')).split('\n')).not.toContain('nested/file')
  expect((await f.status()).changes).toEqual([])
})

it('retains unknown locks, rejects modified remotes and symlinked repositories', async () => {
  const f = await fixture(), lock = join(f.home, 'github-workspace/.operation.lock')
  await writeFile(lock, 'another owner')
  await expect(f.call('fetch', { fullName: f.project.fullName })).rejects.toMatchObject({ code: 'busy' })
  expect(await readFile(lock, 'utf8')).toBe('another owner')
  await rm(lock)
  await f.git(f.project.path, 'remote', 'set-url', 'origin', 'https://example.invalid/escape.git')
  await expect(f.status()).rejects.toMatchObject({ code: 'wrongRemote' })
  await f.git(f.project.path, 'remote', 'set-url', 'origin', 'https://github.com/demo/project.git')
  const other = join(f.base, 'other'); await mkdir(other)
  await rm(join(f.project.path, '.git'), { recursive: true }); await symlink(other, join(f.project.path, '.git'))
  await expect(f.status()).rejects.toMatchObject({ code: 'unsafeDirectory' })
  await expect(f.call('open', { fullName: '../../unsafe' })).rejects.toMatchObject({ code: 'invalidRequest' })
})
