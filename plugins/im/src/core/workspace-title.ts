import { createHash, randomUUID } from 'node:crypto'
import { lstat, mkdir, readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import type { HostApiProxy } from './host-api.js'
import { unwrap } from './host-api.js'

function display(value: string): string { return [...value.replace(/[\u0000-\u001f\u007f]/gu, ' ').trim()].slice(0, 80).join('') }
export function channelWorkspaceTitle(platform: '微信' | '企业微信', name: string | undefined, fallback: string): string {
  return `${platform} · ${display(name ?? '') || display(fallback)}`
}
export function accountLabel(accountIds: readonly string[]): string {
  if (accountIds.length !== 1) return `个人账号（${accountIds.length} 个）`
  return '个人账号 ' + createHash('sha256').update(accountIds[0]!).digest('hex').slice(0, 6)
}

/** Rename only the owned path and recognizable generated titles. */
export async function nameManagedWorkspace(api: HostApiProxy,
  dshHome: string,
  created: { created: boolean; workspace: { workspaceId: string; path: string; title: string } },
  path: string, title: string, legacyTitles: readonly string[]): Promise<string> {
  const workspace = created.workspace
  if (resolve(workspace.path) !== resolve(path)) return workspace.workspaceId
  const directory = join(dshHome, 'channels', 'im-workspace-titles')
  const filename = join(directory, createHash('sha256').update(resolve(path)).digest('hex') + '.json')
  let previous: string | undefined
  try {
    await mkdir(directory, { recursive: true, mode: 0o700 })
    if (!(await lstat(directory)).isDirectory()) return workspace.workspaceId
    const stat = await lstat(filename)
    if (!stat.isFile() || stat.size > 4096) return workspace.workspaceId
    const record = JSON.parse(await readFile(filename, 'utf8')) as Record<string, unknown>
    if (record?.owner !== 'dsh-im/workspace-title/v1' || (!created.created && record.workspaceId !== workspace.workspaceId)
      || typeof record.title !== 'string') return workspace.workspaceId
    previous = record.workspaceId === workspace.workspaceId ? record.title : undefined
  } catch (error) {
    // Unknown metadata must not stop message reception or authorize a rename.
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return workspace.workspaceId
  }
  if (!created.created && workspace.title !== title && workspace.title !== previous
    && !legacyTitles.includes(workspace.title)) return workspace.workspaceId
  if (workspace.title !== title) {
    unwrap(await api.workspace.rename({ rpcId: `im-workspace-title-${randomUUID()}`, payload: { workspaceId: workspace.workspaceId, title } }))
  }
  // Titles are advisory metadata. Failure to remember one must not take a
  // working channel offline; a later reconciliation can repair the record.
  await writeFileAtomic(filename, JSON.stringify({ owner: 'dsh-im/workspace-title/v1', workspaceId: workspace.workspaceId, title }),
    { mode: 0o600, dirMode: 0o700 }).catch(() => undefined)
  return workspace.workspaceId
}
