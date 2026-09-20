import { Context } from '@deepseek-ai/cordis'
import ApprovalService, { type ApprovalRequest } from '@deepseek-ai/dsh-user-approval'
import { describe, expect, it, vi } from 'vitest'
import { installChannelApproval } from '../src/approval.js'
import { submitChannelPrompt, type HostApiProxy } from '../src/host-api.js'

function request(signal?: AbortSignal) {
  const events: Array<{ type: string; data: Record<string, unknown> }> = [{ type: 'turn/start', data: {} }]
  return { agent: { id: 'owned', session: { snapshotEvents: () => events, get seq() { return events.length }, eventAt: (seq: number) => events[seq],
    append(type: string, data: Record<string, unknown>) { events.push({ type, data }) } },
  }, toolName: 'bash', callId: 'call-1', ...(signal === undefined ? {} : { signal }) } as unknown as ApprovalRequest
}

describe('upstream approval integration', () => {
  it('uses the official service audit identity and delegates unrelated sessions', async () => {
    const ctx = new Context()
    await ctx.plugin(ApprovalService, { policy: 'ask' })
    const next = vi.fn(async () => 'rejected' as const)
    ctx.on('approval/request', next)
    const present = vi.fn(async () => ({ outcome: 'allowed-once' as const }))
    installChannelApproval(ctx, id => id === 'owned', present)
    const owned = request()
    await expect(ctx.approval.request(owned)).resolves.toBe('allowed-once')
    expect(present.mock.calls.length).toBe(1)
    expect(next).not.toHaveBeenCalled()
    const events = owned.agent.session.snapshotEvents()
    expect(events.filter(event => event.type === 'approval/asked')).toHaveLength(1)
    expect(events.filter(event => event.type === 'approval/decided')).toHaveLength(1)
    const foreign = request()
    Object.assign(foreign.agent, { id: 'foreign' })
    await expect(ctx.approval.request(foreign)).resolves.toBe('rejected')
    expect(next).toHaveBeenCalledOnce()
    await ctx.fiber.dispose()
  })

  it('keeps never policy authoritative and cancels pending channel approval on unload', async () => {
    const ctx = new Context()
    const service = await ctx.plugin(ApprovalService, { policy: 'never' })
    const present = vi.fn(() => new Promise<undefined>(() => {}))
    const fiber = await ctx.plugin({ apply(inner: Context) { installChannelApproval(inner, () => true, present) } })
    await expect(ctx.approval.request(request())).resolves.toBe('rejected')
    expect(present).not.toHaveBeenCalled()
    service.ctx.approval.config = { policy: 'ask' }
    const pending = ctx.approval.request(request())
    await vi.waitFor(() => expect(present).toHaveBeenCalledOnce())
    await fiber.dispose()
    await expect(pending).resolves.toBe('cancelled')
    await ctx.fiber.dispose()
  })

  it('answers an agent-scoped approval from a sibling plugin fiber', async () => {
    const ctx = new Context()
    await ctx.plugin(ApprovalService, { policy: 'ask' })
    const present = vi.fn(async () => ({ outcome: 'allowed-once' as const }))
    await ctx.plugin({ apply(inner: Context) { installChannelApproval(inner, () => true, present) } })
    const owned = request()
    owned.agent.session.append('approval/asked', { id: 'ask-1', callId: 'call-1' } as never)
    const thisArg = { [Context.filter]: () => false }
    await expect(ctx.waterfall(thisArg as never, 'approval/request', owned, async () => 'unavailable' as const))
      .resolves.toBe('allowed-once')
    expect(present).toHaveBeenCalledOnce()
    await ctx.fiber.dispose()
  })
})

describe('upstream prompt admission', () => {
  it('retries a rejected steer as queue once without claiming atomic continuation', async () => {
    const prompt = vi.fn()
      .mockResolvedValueOnce({ rpcId: 'r', result: { ok: false, error: { code: 'agent-busy' } } })
      .mockResolvedValueOnce({ rpcId: 'r', result: { ok: true, value: { accepted: true } } })
    const result = await submitChannelPrompt({ sessions: { prompt } } as unknown as HostApiProxy, {
      rpcId: 'r', payload: { sessionId: 's', mode: 'steer', content: [{ type: 'text', text: 'task' }] },
    })
    expect(prompt.mock.calls.map(([input]) => input.payload.mode)).toEqual(['steer', 'queue'])
    expect(result).toMatchObject({ result: { ok: true, value: { disposition: 'next-turn' } } })
  })
})
