import { copyFile, lstat, open, readFile, realpath, rename, rm } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, sep } from 'node:path'
import type { Account, Change, Preview, Project, ProjectStatus, TaskPhase } from './types.js'
import { WorkspaceError } from './types.js'
import type { CommandOptions, Execute, Result } from './process.js'
import type { EncryptionSupport } from './encryption.js'

export function allowedPath(path: string): boolean {
  if (!path || path.length > 4096 || isAbsolute(path) || /[\\\u0000-\u001f]/u.test(path)) return false
  const parts = path.split('/')
  return parts.every(part => part !== '' && part !== '.' && part !== '..' && part.toLowerCase() !== '.git' &&
    !/^(?:\.credentials(?:\..*)?|\.npmrc|id_rsa|id_ed25519|.*\.(?:pem|p12|pfx|key))$/i.test(part) &&
    (!/^\.env(?:\.|$)/i.test(part) || /^\.env\.(?:example|sample|template)$/i.test(part)))
}

export function changesFromPorcelain(text: string): Change[] {
  const fields = text.split('\0'), changes: Change[] = []
  for (let index = 0; index < fields.length; index++) {
    const record = fields[index]!
    if (!record) continue
    if (record.length < 4 || record[2] !== ' ') throw new WorkspaceError('commandFailed')
    const status = record.slice(0, 2), path = record.slice(3), paths = [path]
    if (/[RC]/.test(status)) { const previous = fields[++index]; if (!previous) throw new WorkspaceError('commandFailed'); paths.push(previous) }
    changes.push({ path, paths, status, blocked: !paths.every(allowedPath) })
  }
  return changes
}

export class Git {
  constructor(private readonly run: Execute, private readonly options: () => CommandOptions, private readonly hooks: string, private readonly encryption?: EncryptionSupport) {}
  async command(cwd: string, args: string[], extra: CommandOptions = {}): Promise<Result> {
    return this.run('git', ['--no-pager', '--literal-pathspecs',
      '-c', 'core.hooksPath=' + this.hooks, '-c', 'core.fsmonitor=false',
      '-c', 'credential.helper=', '-c', 'credential.helper=!gh auth git-credential', '-c', 'credential.useHttpPath=true',
      '-c', 'http.followRedirects=false', '-c', 'protocol.file.allow=never', '-c', 'protocol.ext.allow=never',
      '-c', 'push.followTags=false', '-c', 'submodule.recurse=false', ...this.encryption?.arguments(cwd) ?? [], ...args], { ...this.options(), ...extra, cwd })
  }
  async checked(cwd: string, args: string[], extra: CommandOptions = {}): Promise<string> {
    const result = await this.command(cwd, args, extra)
    if (result.code !== 0) throw new WorkspaceError('commandFailed')
    return result.stdout
  }
  async clone(parent: string, fullName: string, target: string, report?: (phase: TaskPhase, progress?: number) => void): Promise<void> {
    report?.('cloning')
    let pending = ''
    await this.checked(parent, ['-c', 'filter.git-crypt.required=false', '-c', 'filter.git-crypt.clean=', '-c', 'filter.git-crypt.smudge=', 'clone', '--progress', '--no-recurse-submodules', '--', 'https://github.com/' + fullName + '.git', target], {
      timeoutMs: 5 * 60_000, onOutput: text => {
        pending = (pending + text).slice(-4096)
        const updates = [...pending.matchAll(/(Receiving objects|Resolving deltas):\s*(\d+)%/g)]
        const latest = updates.at(-1)
        if (latest) report?.(latest[1] === 'Receiving objects' ? 'receiving' : 'resolving', Number(latest[2]))
      },
    })
  }
  async hasStaged(project: Project): Promise<boolean> {
    const result = await this.command(project.path, ['diff', '--cached', '--quiet'])
    if (![0, 1].includes(result.code)) throw new WorkspaceError('commandFailed')
    return result.code === 1
  }
  async verify(project: Project): Promise<void> {
    const gitDir = await lstat(join(project.path, '.git'))
    if (!gitDir.isDirectory() || gitDir.isSymbolicLink() || await realpath(project.path) !== project.path) throw new WorkspaceError('unsafeDirectory')
    const top = (await this.checked(project.path, ['rev-parse', '--show-toplevel'])).trim()
    if (top !== project.path) throw new WorkspaceError('unsafeDirectory')
    for (const command of [['remote', 'get-url', '--all', 'origin'], ['remote', 'get-url', '--push', '--all', 'origin']]) {
      const urls = (await this.checked(project.path, command)).trim().split('\n')
      if (urls.length !== 1 || urls[0] !== 'https://github.com/' + project.fullName + '.git') throw new WorkspaceError('wrongRemote')
    }
  }
  async status(project: Project): Promise<ProjectStatus> {
    await this.verify(project)
    await this.encryption?.ready(project, (args, options) => this.command(project.path, args, options))
    const ref = (await this.checked(project.path, ['symbolic-ref', 'HEAD'])).trim()
    if (!ref.startsWith('refs/heads/')) throw new WorkspaceError('conflict')
    const branch = ref.slice('refs/heads/'.length)
    if (!branch || /[\u0000-\u0020]/u.test(branch)) throw new WorkspaceError('conflict')
    const headResult = await this.command(project.path, ['rev-parse', '--verify', '--quiet', 'HEAD'])
    const head = headResult.code === 0 ? headResult.stdout.trim() : ''
    const changes = changesFromPorcelain(await this.checked(project.path, ['status', '--porcelain=v1', '-z', '--untracked-files=all']))
    let conflicted = changes.some(change => /U/.test(change.status) || ['AA', 'DD'].includes(change.status))
    for (const name of ['MERGE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD', 'rebase-merge', 'rebase-apply']) {
      try { await lstat(join(project.path, '.git', name)); conflicted = true } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
    }
    const remote = await this.command(project.path, ['rev-parse', '--verify', '--quiet', 'refs/remotes/origin/' + branch])
    let ahead = 0, behind = 0
    if (head && remote.code === 0) {
      const counts = (await this.checked(project.path, ['rev-list', '--left-right', '--count', head + '...refs/remotes/origin/' + branch])).trim().split(/\s+/).map(Number)
      ahead = counts[0]!; behind = counts[1]!
    } else if (head) ahead = Number((await this.checked(project.path, ['rev-list', '--count', head])).trim())
    return { project, head, branch, ahead, behind, changes, conflicted, remoteKnown: remote.code === 0 }
  }
  async fetch(project: Project): Promise<ProjectStatus> {
    await this.verify(project)
    await this.checked(project.path, ['fetch', '--no-tags', '--no-recurse-submodules', 'origin'])
    return this.status(project)
  }
  async pull(project: Project): Promise<ProjectStatus> {
    let state = await this.status(project)
    if (state.changes.length) throw new WorkspaceError('dirty')
    if (state.conflicted) throw new WorkspaceError('conflict')
    state = await this.fetch(project)
    if (!state.remoteKnown || !state.head || (state.ahead > 0 && state.behind > 0)) throw new WorkspaceError('conflict')
    if ((await this.command(project.path, ['merge', '--ff-only', '--no-edit', 'refs/remotes/origin/' + state.branch])).code !== 0) throw new WorkspaceError('pullFailed')
    return this.status(project)
  }
  async stage(project: Project, paths: string[], scratch: string): Promise<{ tree: string; index: string; diff: string }> {
    if (!paths.length || paths.length > 100 || !paths.every(allowedPath) || new Set(paths).size !== paths.length) throw new WorkspaceError('sensitiveFile')
    const state = await this.status(project)
    if (state.conflicted) throw new WorkspaceError('conflict')
    if (project.encryption && paths.some(path => path === '.gitattributes' || path.endsWith('/.gitattributes'))) throw new WorkspaceError('encryptionUnsafe')
    const eligible = new Set(state.changes.filter(change => !change.blocked).flatMap(change => change.paths))
    if (paths.some(path => !eligible.has(path))) throw new WorkspaceError('stalePreview')
    for (const path of paths) {
      let parentPath = dirname(join(project.path, path)), parent: string
      for (;;) {
        try { parent = await realpath(parentPath); break } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || parentPath === project.path) throw error
          parentPath = dirname(parentPath)
        }
      }
      if (relative(project.path, parent).split(sep).includes('..') || isAbsolute(relative(project.path, parent))) throw new WorkspaceError('unsafeDirectory')
      try {
        const info = await lstat(join(project.path, path))
        if (info.isFile() && info.size > 5 * 1024 * 1024) throw new WorkspaceError('tooLarge')
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
    }
    const index = join(scratch, 'review.index'), env = { ...this.options().env, GIT_INDEX_FILE: index }
    await this.checked(project.path, state.head ? ['read-tree', state.head] : ['read-tree', '--empty'], { env })
    const prior = await this.encryption?.protectedPaths((args, options) => this.command(project.path, args, options), paths, env)
    await this.checked(project.path, ['add', '--all', '--', ...paths], { env })
    const tree = (await this.checked(project.path, ['write-tree'], { env })).trim()
    const protectedPaths = await this.encryption?.protectedPaths((args, options) => this.command(project.path, args, options), paths, env)
    await this.encryption?.plaintext(project, new Set([...prior ?? [], ...protectedPaths ?? []]))
    await this.encryption?.verifyTree(project, (args, options) => this.command(project.path, args, options), tree, paths, env, prior)
    const diff = await this.checked(project.path, ['diff', '--cached', '--no-ext-diff', '--no-textconv', ...(state.head ? [state.head] : []), '--', ...paths], { env, maxBytes: 1024 * 1024 })
    if (!diff) throw new WorkspaceError('nothingToSave')
    return { tree, index, diff }
  }
  /** Commit the reviewed immutable tree, preserving unrelated staged entries.
   * The native index lock blocks concurrent staging; update-ref compares HEAD.
   * No working-tree files or repository hooks are executed by this operation.
   */
  private async assertWorkflow(project: Project, kind: 'commit' | 'push'): Promise<void> {
    await this.verify(project)
    // A plumbing commit must never silently bypass a configured project policy.
    const code = kind === 'commit' ? 'projectCommitFlow' : 'projectPushFlow'
    const config = await this.run('git', ['config', '--get-regexp', '^(core\\.hooksPath|commit\\.gpgSign)$'], {
      ...this.options(), cwd: project.path, env: { ...this.options().env, GIT_CONFIG_GLOBAL: undefined, GIT_CONFIG_NOSYSTEM: undefined },
    })
    if (config.code !== 0 && config.code !== 1) throw new WorkspaceError('commandFailed')
    if (config.stdout.split('\n').some(line => /^core\.hookspath\s+\S/i.test(line) || (kind === 'commit' && /^commit\.gpgsign\s+(?:true|yes|on|1)\s*$/i.test(line)))) throw new WorkspaceError(code)
    for (const name of kind === 'commit' ? ['pre-commit', 'prepare-commit-msg', 'commit-msg', 'post-commit'] : ['pre-push']) {
      try {
        const hook = await lstat(join(project.path, '.git/hooks', name))
        if (hook.isSymbolicLink() || (hook.isFile() && (hook.mode & 0o111) !== 0)) throw new WorkspaceError(code)
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
    }
  }
  async commit(project: Project, preview: Preview, message: string, account: Account, scratch: string, automatic = false): Promise<ProjectStatus> {
    await this.assertWorkflow(project, 'commit')
    const state = await this.status(project)
    if (state.head !== preview.head || state.conflicted) throw new WorkspaceError('stalePreview')
    const reviewed = await this.stage(project, preview.paths, scratch)
    if (reviewed.tree !== preview.tree) throw new WorkspaceError('stalePreview')
    const lockPath = join(project.path, '.git/index.lock'), indexPath = join(project.path, '.git/index')
    let lock
    try { lock = await open(lockPath, 'wx', 0o600) } catch (error) { if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new WorkspaceError('busy'); throw error }
    let advanced = false, installed = false
    try {
      try {
        const index = await lstat(indexPath)
        if (!index.isFile() || index.isSymbolicLink()) throw new WorkspaceError('unsafeDirectory')
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
      const fresh = await this.status(project)
      if (automatic && await this.hasStaged(project)) throw new WorkspaceError('stagedChanges')
      if (fresh.head !== preview.head || fresh.branch !== state.branch || fresh.conflicted) throw new WorkspaceError('stalePreview')
      const email = `${account.id}+${account.login}@users.noreply.github.com`
      const env = { ...this.options().env, GIT_AUTHOR_NAME: account.login, GIT_COMMITTER_NAME: account.login, GIT_AUTHOR_EMAIL: email, GIT_COMMITTER_EMAIL: email }
      const commit = (await this.checked(project.path, ['commit-tree', preview.tree, ...(preview.head ? ['-p', preview.head] : []), '-m', message], { env })).trim()
      const nextIndex = join(scratch, 'after.index'), nextEnv = { ...this.options().env, GIT_INDEX_FILE: nextIndex }
      try { await copyFile(indexPath, nextIndex) } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
        await this.checked(project.path, ['read-tree', '--empty'], { env: nextEnv })
      }
      await this.checked(project.path, ['reset', '-q', commit, '--', ...preview.paths], { env: nextEnv })
      await lock.writeFile(await readFile(nextIndex)); await lock.sync()
      const updated = await this.command(project.path, ['update-ref', '-m', 'github-workspace: save reviewed changes', 'refs/heads/' + state.branch, commit, preview.head || '0'.repeat(commit.length)])
      if (updated.code !== 0) throw new WorkspaceError('stalePreview')
      advanced = true
      await lock.close(); lock = undefined
      await rename(lockPath, indexPath); installed = true
      return await this.status(project)
    } catch (error) { if (advanced && !installed) throw new WorkspaceError('indexRefresh'); throw error }
    finally { await lock?.close(); if (!installed) await rm(lockPath, { force: true }) }
  }
  async push(project: Project, head: string): Promise<ProjectStatus> {
    await this.assertWorkflow(project, 'push')
    const state = await this.status(project)
    if (!head || state.head !== head || state.conflicted) throw new WorkspaceError('stalePreview')
    await this.encryption?.audit(project, (args, options) => this.command(project.path, args, options))
    if ((await this.command(project.path, ['push', '--porcelain', '--', 'origin', head + ':refs/heads/' + state.branch])).code !== 0) throw new WorkspaceError('pushFailed')
    return this.status(project)
  }
}
