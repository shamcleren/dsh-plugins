import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { ensureWeChatWorkspace } from '../src/workspace.js'
import type { HostApiProxy } from '../src/host-api.js'

it('keeps the default conversation workspace outside the channel credential directory', async () => {
  const home = await mkdtemp(join(tmpdir(), 'wechat-workspace-'))
  const create = vi.fn(async (request: Parameters<HostApiProxy['workspace']['create']>[0]) => ({ rpcId: request.rpcId, result: { ok: true as const, value: { workspace: { workspaceId: 'workspace', path: request.payload.path, title: '微信机器人', sessionIds: [] }, created: false } } }))
  try {
    expect(await ensureWeChatWorkspace({ workspace: { create } } as unknown as HostApiProxy, home, '微信机器人')).toBe('workspace')
    expect(create.mock.calls[0]?.[0].payload.path).toBe(join(home, 'workspaces/wechat'))
  } finally { await rm(home, { recursive: true, force: true }) }
})
