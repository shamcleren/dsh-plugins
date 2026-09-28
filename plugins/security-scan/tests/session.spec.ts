import { Context } from '@deepseek-ai/cordis'
import { SessionStore, SessionId } from '@deepseek-ai/dsh-session'
import { expect, it, vi } from 'vitest'
import { scanSession } from '../src/session.js'
import { RunSchema, newTask } from '../src/ui-contract.js'
import { randomUUID } from 'node:crypto'

it('durably appends plugin notices to an existing session without model prompts', async () => {
  const ctx = new Context(), fiber = await ctx.plugin(SessionStore)
  const flushed = vi.fn(); fiber.ctx.on('session/flush', flushed)
  try {
    const id = 'conversation-session'
    fiber.ctx.sessions.create(SessionId(id), { meta: { cwd: '/tmp' } })
    const config = { ...newTask(), name: 'Sample', target: '/tmp', syncSession: true }
    const run = RunSchema.parse({ id: randomUUID(), taskId: randomUUID(), config, status: 'running', phase: 'scanning', trigger: 'conversation', createdAt: new Date().toISOString() })
    const mirror = scanSession(fiber.ctx)
    await mirror.publish(id, run)
    const session = fiber.ctx.sessions.get(SessionId(id))!
    expect(session.snapshotEvents()).toHaveLength(1)
    expect(session.snapshotEvents()[0]).toMatchObject({ type: 'user/message', data: { source: { kind: 'security-scan', form: 'notice' } } })
    expect(session.deriveMessages()).toHaveLength(1)
    expect(flushed).toHaveBeenCalledOnce()
    await mirror.publish(id, { ...run, phase: 'finished', status: 'partial', diagnostics: ['source limit'] })
    expect(session.snapshotEvents()).toHaveLength(2)
    await expect(mirror.publish('missing-session', run)).rejects.toThrow('scan-session-unavailable')
  } finally { await ctx.fiber.dispose() }
})
