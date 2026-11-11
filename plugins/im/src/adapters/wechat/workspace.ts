/** Workspace bootstrap for channel-owned Sessions. */

import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import type { HostApiProxy, HostWorkspace, RpcRequest } from './host-api.js'
import { unwrap } from './host-api.js'

let requestSequence = 0

function request<T>(payload: T): RpcRequest<T> {
  requestSequence += 1
  return { rpcId: `wechat-workspace-${String(process.pid)}-${String(requestSequence)}`, payload }
}

/** Create or reuse the plugin's private directory-backed Workspace. */
export async function ensureWeChatWorkspace(
  api: HostApiProxy,
  dshHome: string,
  title: string,
): Promise<string> {
  const path = join(dshHome, 'workspaces', 'wechat')
  await mkdir(path, { recursive: true, mode: 0o700 })
  const created = unwrap(await api.workspace.create(request({ path })))
  if (created.created && created.workspace.title !== title) {
    const renamed = unwrap(await api.workspace.rename(request({
      workspaceId: created.workspace.workspaceId,
      title,
    })))
    return renamed.workspace.workspaceId
  }
  return created.workspace.workspaceId
}

/** Resolve an explicit default Workspace or create the channel fallback. */
export async function resolveDefaultWorkspace(
  api: HostApiProxy,
  dshHome: string,
  workspaceId: string | undefined,
  fallbackTitle: string,
): Promise<HostWorkspace> {
  if (workspaceId !== undefined) {
    const workspaces = unwrap(await api.workspace.list(request({}))).items
    const selected = workspaces.find(workspace => workspace.workspaceId === workspaceId)
    if (selected === undefined) {
      throw new Error(`wechat: configured workspace "${workspaceId}" was not found`)
    }
    return selected
  }
  const fallbackId = await ensureWeChatWorkspace(api, dshHome, fallbackTitle)
  const workspaces = unwrap(await api.workspace.list(request({}))).items
  const fallback = workspaces.find(workspace => workspace.workspaceId === fallbackId)
  if (fallback === undefined) {
    throw new Error(`wechat: fallback workspace "${fallbackId}" disappeared after creation`)
  }
  return fallback
}
