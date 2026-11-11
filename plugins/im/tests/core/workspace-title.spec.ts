import { createHash } from 'node:crypto'
import { lstat, mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import { accountLabel, channelWorkspaceTitle, nameManagedWorkspace } from '../../src/core/workspace-title.js'
import type { HostApiProxy } from '../../src/core/host-api.js'
import { resolveDefaultWorkspace } from '../../src/adapters/wecom/workspace.js'

vi.mock('@deepseek-ai/dsh-atomic-write', async importOriginal => {
  const actual = await importOriginal<typeof import('@deepseek-ai/dsh-atomic-write')>()
  return { ...actual, writeFileAtomic: vi.fn(actual.writeFileAtomic) }
})

const homes: string[] = []
afterEach(async () => { await Promise.all(homes.splice(0).map(home => rm(home, { recursive: true, force: true }))) })
async function fixture(title = '企业微信机器人') {
  const home = await mkdtemp(join(tmpdir(), 'im-titles-')); homes.push(home)
  const path = join(home, 'channels/wecom-aibot/bots/notes')
  const workspace = { workspaceId: 'workspace-notes', path, title, sessionIds: ['existing-session'] }
  const created = { created: false, workspace }
  const rename = vi.fn(async (request: Parameters<HostApiProxy['workspace']['rename']>[0]) => {
    workspace.title = request.payload.title
    return { rpcId: request.rpcId, result: { ok: true as const, value: { workspace } } }
  })
  const api = { workspace: {
    rename,
    create: vi.fn(async (request: { rpcId: string }) => ({ rpcId: request.rpcId, result: { ok: true as const, value: created } })),
    list: vi.fn(async (request: { rpcId: string }) => ({ rpcId: request.rpcId, result: { ok: true as const, value: { items: [workspace], archivedSessionIds: [] } } })),
  } } as unknown as HostApiProxy
  const directory = join(home, 'channels/im-workspace-titles')
  const filename = join(directory, createHash('sha256').update(path).digest('hex') + '.json')
  const apply = (next: string) => nameManagedWorkspace(api, home, created, path, next, ['企业微信机器人'])
  return { home, path, workspace, created, rename, api, apply, filename, directory }
}

it('labels names and stable fallback identities without exposing raw WeChat account IDs', () => {
  expect(channelWorkspaceTitle('企业微信', '生活助手', 'default')).toBe('企业微信 · 生活助手')
  expect(channelWorkspaceTitle('企业微信', undefined, 'bot_ab12')).toBe('企业微信 · bot_ab12')
  expect(channelWorkspaceTitle('微信', '  \n ', '个人账号')).toBe('微信 · 个人账号')
  expect(channelWorkspaceTitle('微信', '\u0000名字\n', 'fallback')).toBe('微信 · 名字')
  expect(channelWorkspaceTitle('微信', '字'.repeat(100), 'fallback')).toBe('微信 · ' + '字'.repeat(80))
  expect(accountLabel(['private-account-a'])).toMatch(/^个人账号 [a-f0-9]{6}$/)
  expect(accountLabel(['private-account-a'])).toBe(accountLabel(['private-account-a']))
  expect(accountLabel(['private-account-b'])).not.toBe(accountLabel(['private-account-a']))
  expect(accountLabel(['a', 'b'])).toBe('个人账号（2 个）')
})

it('migrates a legacy title, remembers generated titles across instances and preserves the ID and sessions', async () => {
  const f = await fixture()
  expect(await f.apply('企业微信 · 生活助手')).toBe('workspace-notes')
  expect(f.workspace.sessionIds).toEqual(['existing-session'])
  expect((await lstat(f.filename)).mode & 0o777).toBe(0o600)
  await f.apply('企业微信 · 生活助手')
  expect(f.rename).toHaveBeenCalledTimes(1)
  await f.apply('企业微信 · 开发助手')
  expect(f.workspace.title).toBe('企业微信 · 开发助手')
  expect(f.rename).toHaveBeenCalledTimes(2)
  f.workspace.title = '手工命名的笔记'
  await f.apply('企业微信 · 新名称')
  expect(f.workspace.title).toBe('手工命名的笔记')
  expect(f.rename).toHaveBeenCalledTimes(2)
})

it('names a new workspace and preserves an existing custom title and a foreign path', async () => {
  const f = await fixture('原有项目')
  await f.apply('企业微信 · 助手')
  expect(f.rename).not.toHaveBeenCalled()
  f.created.created = true
  await f.apply('企业微信 · 助手')
  expect(f.rename).toHaveBeenCalledOnce()
  f.workspace.path = join(f.home, 'somewhere-else')
  await f.apply('企业微信 · 其他名字')
  expect(f.rename).toHaveBeenCalledOnce()
})

it.each(['malformed', 'owner', 'identity', 'title', 'oversized', 'symlink'] as const)('preserves unknown %s metadata without taking the channel offline', async kind => {
  const f = await fixture()
  await mkdir(f.directory, { recursive: true })
  if (kind === 'symlink') {
    const target = join(f.home, 'unrelated'); await writeFile(target, 'untouched'); await symlink(target, f.filename)
  } else await writeFile(f.filename, kind === 'malformed' ? '{' : kind === 'oversized' ? 'x'.repeat(4097)
    : JSON.stringify({ owner: kind === 'owner' ? 'unknown' : 'dsh-im/workspace-title/v1',
      workspaceId: kind === 'identity' ? 'different' : f.workspace.workspaceId, title: kind === 'title' ? 42 : '企业微信机器人' }))
  const original = await readFile(f.filename, 'utf8')
  await f.apply('企业微信 · 助手')
  expect(f.rename).not.toHaveBeenCalled()
  expect(await readFile(f.filename, 'utf8')).toBe(original)
})

it('preserves a symlinked metadata directory', async () => {
  const f = await fixture(), target = join(f.home, 'unrelated')
  await mkdir(target); await mkdir(join(f.home, 'channels'), { recursive: true }); await symlink(target, f.directory)
  await f.apply('企业微信 · 助手')
  expect(f.rename).not.toHaveBeenCalled(); expect(await readdir(target)).toEqual([])
})

it('leaves explicitly selected workspaces unchanged', async () => {
  const f = await fixture()
  await resolveDefaultWorkspace(f.api, f.home, f.workspace.workspaceId, '企业微信 · 助手', 'notes', ['企业微信机器人'])
  expect(f.rename).not.toHaveBeenCalled(); expect(f.api.workspace.create).not.toHaveBeenCalled()
})

it('recovers owned metadata for a recreated workspace and continues if the advisory write fails', async () => {
  const f = await fixture()
  await f.apply('企业微信 · 旧名称')
  f.created.created = true; f.workspace.workspaceId = 'new-workspace'
  vi.mocked(writeFileAtomic).mockRejectedValueOnce(new Error('fixture disk full'))
  expect(await f.apply('企业微信 · 新名称')).toBe('new-workspace')
  expect(f.workspace.title).toBe('企业微信 · 新名称')
  expect(JSON.parse(await readFile(f.filename, 'utf8')).workspaceId).toBe('workspace-notes')
})

it('preserves an unavailable metadata directory and propagates a refused Host rename', async () => {
  const f = await fixture()
  await mkdir(join(f.home, 'channels'), { recursive: true }); await writeFile(f.directory, 'unrelated')
  await f.apply('企业微信 · 助手')
  expect(f.rename).not.toHaveBeenCalled()
  await rm(f.directory)
  vi.spyOn(f.api.workspace, 'rename').mockResolvedValueOnce({ rpcId: 'refused', result: { ok: false, error: { code: 'denied', message: 'fixture' } } })
  await expect(f.apply('企业微信 · 助手')).rejects.toThrow('fixture')
  expect(await readdir(f.directory)).toEqual([])
})
