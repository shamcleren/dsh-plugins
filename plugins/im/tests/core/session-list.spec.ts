import { Context } from '@deepseek-ai/cordis'
import { expect, it, vi } from 'vitest'
import { createHostApi, type HostApiProxy } from '../../src/core/host-api.js'

it('reads canonical titles through the public roster and returns only requested unarchived sessions', async () => {
  const ctx = new Context()
  const list = vi.fn(async () => ({ items: [
    { sessionId: 'owned', running: true, projections: { values: { title: 'Current Host title' } } },
    { sessionId: 'untitled', running: false, projections: { values: { title: null } } },
    { sessionId: 'foreign', running: false, projections: { values: { title: 'private foreign title' } } },
    { sessionId: 'archived', running: false, projections: { values: { title: 'archived topic' } } },
  ] }))
  ctx.provide('sessionController', { list } as never)
  ctx.provide('workspaceRegistry', { archivedSessionIds: ['archived'], list: () => [
    { title: 'Project Alpha', sessionIds: ['owned'] },
    { title: 'Private workspace', sessionIds: ['foreign'] },
  ] } as never)
  let api!: HostApiProxy
  await ctx.plugin({ apply(inner: Context) { api = createHostApi(inner, () => false) } })
  try {
    const result = await api.sessions.list({ rpcId: 'list', payload: { sessionIds: ['owned', 'untitled', 'archived'] } })
    expect(result).toEqual({ rpcId: 'list', result: { ok: true, value: { items: [
      { sessionId: 'owned', title: 'Current Host title', running: true, workspaceTitle: 'Project Alpha' },
      { sessionId: 'untitled', title: '', running: false },
    ] } } })
    expect(list).toHaveBeenCalledWith({}, expect.any(AbortSignal))
  } finally { await ctx.fiber.dispose() }
})
