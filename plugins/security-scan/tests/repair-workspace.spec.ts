import { afterEach, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { planRepair, prepareRepairWorkspace, previewRepair, repairRepositoryUrl, validateRepairUrl, validateRepairWorkspace } from '../src/repair-workspace.js'
const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })
const signal = () => AbortSignal.timeout(10000)
const git = (cwd: string, ...args: string[]) => execFileSync('/usr/bin/git', ['-c', 'core.hooksPath=/dev/null', ...args], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'repair-worktree-'))); roots.push(root)
  const repo = join(root, 'repo'), store = join(root, 'store'); await mkdir(repo); await mkdir(store)
  git(repo, 'init', '-b', 'main'); git(repo, 'config', 'user.email', 'fixture@example.invalid'); git(repo, 'config', 'user.name', 'Fixture')
  await mkdir(join(repo, 'src')); await writeFile(join(repo, 'src/app.py'), 'print("original")\n')
  git(repo, 'add', '.'); git(repo, 'commit', '-m', 'fixture'); git(repo, 'remote', 'add', 'origin', 'git@github.com:example/project.git')
  return { root, repo, store }
}
it('creates an isolated branch once, preserves edits on retry, and validates branch ownership', async () => {
  const f = await fixture(), id = randomUUID(), preview = await previewRepair(join(f.repo, 'src'), signal())
  const plan = await planRepair(join(f.repo, 'src'), f.store, id, 'source-identity', preview.revision, signal())
  await prepareRepairWorkspace(plan, f.store, id, signal())
  expect(plan.target).toBe(join(plan.directory, 'src'))
  expect(git(f.repo, 'branch', '--show-current')).toBe('main')
  expect(git(plan.directory, 'branch', '--show-current')).toBe(plan.branch)
  await writeFile(join(plan.target, 'app.py'), 'print("fixed")\n')
  await prepareRepairWorkspace(plan, f.store, id, signal())
  expect(await readFile(join(f.repo, 'src/app.py'), 'utf8')).toContain('original')
  expect(await readFile(join(plan.target, 'app.py'), 'utf8')).toContain('fixed')
  git(plan.directory, 'switch', '-c', 'other')
  await expect(validateRepairWorkspace(plan, signal())).rejects.toThrow('repair-pr-worktree')
})
it('refuses dirty repositories and stale previews without creating a worktree', async () => {
  const f = await fixture(), preview = await previewRepair(f.repo, signal())
  await writeFile(join(f.repo, 'untracked'), 'keep me')
  await expect(planRepair(f.repo, f.store, randomUUID(), 'identity', preview.revision, signal())).rejects.toThrow('repair-pr-dirty')
  git(f.repo, 'add', '.'); git(f.repo, 'commit', '-m', 'changed')
  await expect(planRepair(f.repo, f.store, randomUUID(), 'identity', preview.revision, signal())).rejects.toThrow('repair-pr-changed')
  expect(git(f.repo, 'worktree', 'list', '--porcelain').match(/^worktree /gm)).toHaveLength(1)
})
it('rejects unknown directories and does not overwrite their files', async () => {
  const f = await fixture(), id = randomUUID(), preview = await previewRepair(f.repo, signal())
  const plan = await planRepair(f.repo, f.store, id, 'identity', preview.revision, signal())
  await mkdir(plan.directory, { recursive: true }); await writeFile(join(plan.directory, 'keep'), 'owned by someone else')
  await expect(prepareRepairWorkspace(plan, f.store, id, signal())).rejects.toThrow()
  expect(await readFile(join(plan.directory, 'keep'), 'utf8')).toBe('owned by someone else')
})
it.each(['https://token@github.com/a/b', 'https://github.com/a/b?token=secret', 'ext::bad', 'ssh://user:secret@gitlab.example.com/a/b'])('rejects unsafe or unsupported remote %s', url => {
  expect(() => repairRepositoryUrl(url)).toThrow('repair-pr-remote')
})
it('accepts scoped PR links but rejects credentials, query strings and other repositories', async () => {
  const f = await fixture(), preview = await previewRepair(f.repo, signal())
  const plan = await planRepair(f.repo, f.store, randomUUID(), 'identity', preview.revision, signal())
  expect(validateRepairUrl(plan, 'https://github.com/example/project/pull/12')).toBe('https://github.com/example/project/pull/12')
  for (const value of ['https://github.com/other/project/pull/12', 'https://github.com/example/project/pull/12?token=secret', 'javascript:alert(1)']) expect(() => validateRepairUrl(plan, value)).toThrow()
  plan.repositoryUrl = 'https://gitlab.example.com/team/project'
  expect(validateRepairUrl(plan, 'https://gitlab.example.com/team/project/-/merge_requests/12')).toContain('/-/merge_requests/12')
})

it('rejects a changed target branch even when its commit matches the preview', async () => {
  const f = await fixture(), preview = await previewRepair(f.repo, signal())
  git(f.repo, 'switch', '-c', 'different-target')
  await expect(planRepair(f.repo, f.store, randomUUID(), 'identity', preview.revision, signal())).rejects.toThrow('repair-pr-changed')
})

it('allows a local repair branch without a remote or supported platform', async () => {
  const f = await fixture()
  git(f.repo, 'remote', 'remove', 'origin')
  const preview = await previewRepair(f.repo, signal())
  expect(preview.repositoryUrl).toBe('')
  const id = randomUUID(), plan = await planRepair(f.repo, f.store, id, 'identity', preview.revision, signal())
  await prepareRepairWorkspace(plan, f.store, id, signal())
  expect(git(plan.directory, 'branch', '--show-current')).toBe(plan.branch)
  expect(() => validateRepairUrl(plan, 'https://github.com/example/project/pull/1')).toThrow()
  expect(repairRepositoryUrl('git@git.example.test:team/project.git')).toBe('https://git.example.test/team/project')
})
