import { mkdtemp } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { describe, expect, it, vi } from 'vitest'
import type { HostApiProxy, HostWorkspace, RpcRequest, RpcResponse } from '../src/host-api.js'
import { resolveDefaultWorkspace } from '../src/workspace.js'

function success<T>(request: RpcRequest<unknown>, value: T): RpcResponse<T> {
  return { rpcId: request.rpcId, result: { ok: true, value } }
}

function workspace(workspaceId: string, title: string, path: string): HostWorkspace {
  return { workspaceId, title, path, sessionIds: [] }
}

describe('WeCom default Workspace resolution', () => {
  it('uses the configured existing Workspace without creating a channel directory', async () => {
    const selected = workspace('workspace-project', '项目 Alpha', '/workspaces/project-alpha')
    const list = vi.fn(async (request: RpcRequest<Record<string, never>>) => success(request, {
      items: [selected], archivedSessionIds: [],
    }))
    const create = vi.fn()
    const api = { workspace: { list, create, rename: vi.fn() } } as unknown as HostApiProxy

    await expect(resolveDefaultWorkspace(
      api, '/unused', selected.workspaceId, '企业微信机器人',
    )).resolves.toEqual(selected)
    expect(create).not.toHaveBeenCalled()
  })

  it('creates and returns the managed fallback when no Workspace is configured', async () => {
    const home = await mkdtemp(join(tmpdir(), 'wecom-workspace-'))
    const fallbackPath = join(home, 'channels', 'wecom-aibot')
    const fallback = workspace('workspace-wecom', '企业微信机器人', fallbackPath)
    const list = vi.fn(async (request: RpcRequest<Record<string, never>>) => success(request, {
      items: [fallback], archivedSessionIds: [],
    }))
    const create = vi.fn(async (request: RpcRequest<{ path: string }>) => success(request, {
      workspace: fallback,
      created: true,
    }))
    const rename = vi.fn(async (request: RpcRequest<{ workspaceId: string; title: string }>) => success(request, {
      workspace: fallback,
    }))
    const api = { workspace: { list, create, rename } } as unknown as HostApiProxy

    await expect(resolveDefaultWorkspace(
      api, home, undefined, '企业微信机器人',
    )).resolves.toEqual(fallback)
    expect(create.mock.calls[0]?.[0].payload.path).toBe(fallbackPath)
  })
})
