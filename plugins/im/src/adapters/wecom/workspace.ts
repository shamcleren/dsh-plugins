/** Workspace bootstrap for channel-owned Sessions. */

import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import type { HostApiProxy, HostWorkspace, RpcRequest } from './host-api.js'
import { unwrap } from './host-api.js'
import { nameManagedWorkspace } from '../../core/workspace-title.js'

let requestSequence = 0

function request<T>(payload: T): RpcRequest<T> {
  requestSequence += 1
  return { rpcId: `wecom-workspace-${String(process.pid)}-${String(requestSequence)}`, payload }
}

/** Create or reuse the plugin's private directory-backed Workspace. */
export async function ensureWeComWorkspace(
  api: HostApiProxy,
  dshHome: string,
  title: string,
  botId?: string,
  legacyTitles: readonly string[] = [],
): Promise<string> {
  const path = join(dshHome, 'channels', 'wecom-aibot', ...(botId === undefined ? [] : ['bots', botId]))
  await mkdir(path, { recursive: true, mode: 0o700 })
  const created = unwrap(await api.workspace.create(request({ path })))
  return nameManagedWorkspace(api, dshHome, created, path, title, legacyTitles)
}

/** Resolve an explicit default Workspace or create the channel fallback. */
export async function resolveDefaultWorkspace(
  api: HostApiProxy,
  dshHome: string,
  workspaceId: string | undefined,
  fallbackTitle: string,
  botId?: string,
  legacyTitles: readonly string[] = [],
): Promise<HostWorkspace> {
  if (workspaceId !== undefined) {
    const workspaces = unwrap(await api.workspace.list(request({}))).items
    const selected = workspaces.find(workspace => workspace.workspaceId === workspaceId)
    if (selected === undefined) {
      throw new Error(`wecom-aibot: configured workspace "${workspaceId}" was not found`)
    }
    return selected
  }
  const fallbackId = await ensureWeComWorkspace(api, dshHome, fallbackTitle, botId, legacyTitles)
  const workspaces = unwrap(await api.workspace.list(request({}))).items
  const fallback = workspaces.find(workspace => workspace.workspaceId === fallbackId)
  if (fallback === undefined) {
    throw new Error(`wecom-aibot: fallback workspace "${fallbackId}" disappeared after creation`)
  }
  return fallback
}
