import type { WorkspaceId } from '@deepseek-ai/dsh-workspace'
import { Context } from '@deepseek-ai/cordis'
import { SessionStore, SessionId } from '@deepseek-ai/dsh-session'
import { expect, it, vi } from 'vitest'
import { scanSession } from '../src/session.js'
import { RunSchema, newTask } from '../src/ui-contract.js'
import { randomUUID } from 'node:crypto'

it('creates an ordinary DSH session and durably appends plugin notices without model prompts', async () => {
  const ctx = new Context(), fiber = await ctx.plugin(SessionStore)
  const flushed = vi.fn(); fiber.ctx.on('session/flush', flushed)
  const api: Parameters<typeof scanSession>[0] = {
    create: vi.fn(async request => { const id = request.sessionId!; fiber.ctx.sessions.create(id, { meta: { cwd: '/tmp' } }); return { sessionId: id } }),
    rename: vi.fn(async request => ({ title: request.title, seq: 0 })),
  }
  const workspace = { create: vi.fn(async () => ({ id: 'workspace-fixture' as WorkspaceId })) } as unknown as Parameters<typeof scanSession>[1]

  try {
    const config = { ...newTask(), name: 'Sample', target: '/tmp', syncSession: true }
    const run = RunSchema.parse({ id: randomUUID(), taskId: randomUUID(), config, status: 'running', phase: 'scanning', trigger: 'manual', createdAt: new Date().toISOString() })
    const mirror = scanSession(api, workspace, fiber.ctx.sessions), id = await mirror.start(run, '/tmp')
    await mirror.publish(id, run)
    const session = fiber.ctx.sessions.get(SessionId(id))!
    expect(session.snapshotEvents()).toHaveLength(1)
    expect(session.snapshotEvents()[0]).toMatchObject({ type: 'user/message', data: { source: { kind: 'plugin', plugin: 'security-scan', form: 'notice' } } })
    expect(session.deriveMessages()).toHaveLength(1)
    expect(flushed).toHaveBeenCalledOnce()
    expect(api.create).toHaveBeenCalledOnce()
    await mirror.publish(id, { ...run, phase: 'finished', status: 'partial', diagnostics: ['source limit'] })
    expect(session.snapshotEvents()).toHaveLength(2)
  } finally { await ctx.fiber.dispose() }
})
