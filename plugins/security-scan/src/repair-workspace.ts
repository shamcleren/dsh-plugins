import { lstat, mkdir, realpath } from 'node:fs/promises'
import { isAbsolute, join, relative } from 'node:path'
import { git, inside, hash } from './repository.js'
import type { RepairWorkspace } from './ui-contract.js'

/** Only credential-free repository identities are exposed to the UI and model. */
export function repairRepositoryUrl(remote: string): string {
  const scp = /^git@([A-Za-z0-9.-]+):(.+)$/u.exec(remote)
  const text = scp ? 'https://' + scp[1] + '/' + scp[2] : remote
  let url: URL
  try { url = new URL(text) } catch { throw new Error('repair-pr-remote') }
  if (!['https:', 'ssh:'].includes(url.protocol) || !url.hostname || url.password || (url.username && !(url.protocol === 'ssh:' && url.username === 'git')) || url.port || url.search || url.hash) throw new Error('repair-pr-remote')
  const path = url.pathname.replace(/\.git$/u, '').replace(/\/$/u, '')
  if (!/^\/[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)+$/u.test(path) || path.split('/').some(part => part === '.' || part === '..')) throw new Error('repair-pr-remote')
  return 'https://' + url.hostname + path
}
export async function previewRepair(target: string, signal: AbortSignal) {
  const repository = (await git(target, ['rev-parse', '--show-toplevel'], signal, true)).trim()
  if (!repository || !inside(repository, target)) throw new Error('repair-pr-repository')
  if ((await git(repository, ['status', '--porcelain', '--untracked-files=all'], signal)).trim()) throw new Error('repair-pr-dirty')
  const base = (await git(repository, ['symbolic-ref', '--quiet', '--short', 'HEAD'], signal, true)).trim()
  if (!base) throw new Error('repair-pr-branch')
  const commit = (await git(repository, ['rev-parse', '--verify', 'HEAD'], signal)).trim()
  if (!/^[a-f0-9]{40,64}$/u.test(commit)) throw new Error('repair-pr-repository')
  const remote = (await git(repository, ['remote', 'get-url', '--push', '--all', 'origin'], signal, true)).trim()
  // Remote access is optional: the conversation can deliver the local branch.
  let repositoryUrl = ''
  if (remote && remote.split('\n').length === 1) {
    try { repositoryUrl = repairRepositoryUrl(remote) } catch { /* Never expose credential-bearing or unsupported remote values. */ }
  }
  return { repository, repositoryUrl, base, commit, revision: hash(JSON.stringify([repository, target, repositoryUrl, base, commit])) }
}
export async function planRepair(target: string, root: string, requestId: string, identity: string, expectedRevision: string | undefined, signal: AbortSignal): Promise<RepairWorkspace> {
  const info = await previewRepair(target, signal)
  if (!expectedRevision || info.revision !== expectedRevision) throw new Error('repair-pr-changed')
  const directory = join(root, 'repair-worktrees', requestId)
  const { revision: _revision, ...plan } = info
  return { ...plan, branch: 'security/repair-' + requestId, directory, target: join(directory, relative(info.repository, target)), sourceIdentity: identity }
}
async function optionalStat(path: string) { try { return await lstat(path) } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error } }
export async function validateRepairWorkspace(workspace: RepairWorkspace, signal: AbortSignal): Promise<void> {
  if (await realpath(workspace.directory) !== workspace.directory || await realpath(workspace.target) !== workspace.target || !inside(workspace.directory, workspace.target)) throw new Error('repair-pr-worktree')
  const branch = (await git(workspace.directory, ['symbolic-ref', '--quiet', '--short', 'HEAD'], signal)).trim()
  const common = (await git(workspace.directory, ['rev-parse', '--path-format=absolute', '--git-common-dir'], signal)).trim()
  const original = (await git(workspace.repository, ['rev-parse', '--path-format=absolute', '--git-common-dir'], signal)).trim()
  if (branch !== workspace.branch || await realpath(common) !== await realpath(original)) throw new Error('repair-pr-worktree')
}
/** The saved plan owns the path and branch. Retries never remove or replace existing work. */
export async function prepareRepairWorkspace(workspace: RepairWorkspace, root: string, requestId: string, signal: AbortSignal): Promise<void> {
  const parent = join(root, 'repair-worktrees')
  if (!isAbsolute(root) || workspace.directory !== join(parent, requestId)) throw new Error('repair-pr-worktree')
  if (await optionalStat(parent)) { if (await realpath(parent) !== parent || !(await lstat(parent)).isDirectory()) throw new Error('repair-pr-worktree') }
  else await mkdir(parent, { mode: 0o700 })
  if (!(await optionalStat(workspace.directory))) {
    const current = await previewRepair(workspace.repository, signal)
    if (current.commit !== workspace.commit || current.base !== workspace.base || current.repositoryUrl !== workspace.repositoryUrl) throw new Error('repair-pr-changed')
    // A checkout must not invoke repository-provided smudge/process filters.
    const filters = (await git(workspace.repository, ['config', '--name-only', '--get-regexp', '^filter\\.'], signal, true)).trim().split('\n').filter(Boolean)
    const overrides = [...new Set(filters.map(key => key.slice(0, key.lastIndexOf('.'))))].flatMap(key => ['-c', key + '.smudge=', '-c', key + '.process=', '-c', key + '.required=false'])
    await git(workspace.repository, [...overrides, 'worktree', 'add', '-b', workspace.branch, workspace.directory, workspace.commit], signal)
  }
  await validateRepairWorkspace(workspace, signal)
}
export function validateRepairUrl(workspace: RepairWorkspace, value: string): string {
  if (value.length > 2000) throw new Error('repair-pr-url')
  if (!workspace.repositoryUrl) throw new Error('repair-pr-url')
  const url = new URL(value)
  const prefix = workspace.repositoryUrl + '/'
  if (!value.startsWith(prefix) || !/^(?:-\/)?(?:pull|pulls|pull-requests|merge_requests)\/[1-9][0-9]*$/u.test(value.slice(prefix.length))) throw new Error('repair-pr-url')
  return url.href
}
