/** Channel-owned approval presentation over the upstream approval waterfall. */
import type { Context } from '@deepseek-ai/cordis'
import type { ApprovalOutcome, ApprovalRequest } from '@deepseek-ai/dsh-user-approval'

export interface ChannelApproval {
  id: string
  sessionId: string
  toolName: string
  callId?: string
  reason?: string
  signal: AbortSignal
  resolved: Promise<{ outcome: ApprovalOutcome }>
}

/** Route owned requests to the channel; unrelated sessions delegate to the Host. */
export function installChannelApproval(
  ctx: Context,
  owns: (sessionId: string) => boolean,
  present: (request: ChannelApproval) => Promise<{ outcome: 'allowed-once' | 'rejected' } | undefined>,
): void {
  const lifetime = new AbortController()
  const claimed = new Set<string>()
  const pending = new Set<Promise<ApprovalOutcome>>()
  // Agent-scoped approval dispatch filters sibling plugin fibers; this
  // channel answers owned turns regardless of that fiber filter.
  ctx.on('approval/request', (request, next) => {
    if (!owns(String(request.agent.id))) return next()
    const id = unclaimedApproval(request, claimed)
    if (id === undefined) return next()
    claimed.add(id)
    const work = decide(request, id)
    pending.add(work)
    void work.finally(() => { pending.delete(work); claimed.delete(id) })
    return work
  }, { prepend: true, global: true })
  ctx.effect(() => async () => {
    lifetime.abort()
    await Promise.allSettled([...pending])
  }, 'wechat: pending approvals')

  async function decide(request: ApprovalRequest, id: string): Promise<ApprovalOutcome> {
    const signal = AbortSignal.any([lifetime.signal, ...(request.signal === undefined ? [] : [request.signal])])
    let resolve!: (value: { outcome: ApprovalOutcome }) => void
    const resolved = new Promise<{ outcome: ApprovalOutcome }>(settle => { resolve = settle })
    let outcome: ApprovalOutcome = 'unavailable'
    let onAbort: (() => void) | undefined
    try {
      if (signal.aborted) outcome = 'cancelled'
      else {
        const cancelled = new Promise<undefined>(settle => {
          onAbort = () => { settle(undefined) }
          signal.addEventListener('abort', onAbort, { once: true })
        })
        const answer = await Promise.race([present({
          id, sessionId: String(request.agent.id), toolName: request.toolName,
          ...request.callId === undefined ? {} : { callId: request.callId },
          ...request.reason === undefined ? {} : { reason: request.reason },
          signal, resolved,
        }), cancelled])
        outcome = signal.aborted ? 'cancelled'
          : answer?.outcome === 'allowed-once' ? 'allowed-once'
          : answer?.outcome === 'rejected' ? 'rejected' : 'unavailable'
      }
    } catch {
      // A presentation failure cannot grant permission.
      outcome = signal.aborted ? 'cancelled' : 'unavailable'
    } finally {
      if (onAbort !== undefined) signal.removeEventListener('abort', onAbort)
      resolve({ outcome })
    }
    return outcome
  }
}

function unclaimedApproval(request: ApprovalRequest, claimed: ReadonlySet<string>): string | undefined {
  const decided = new Set<string>()
  const events = request.agent.session.snapshotEvents()
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const event = events[i]
    if (event?.type === 'approval/decided') decided.add(event.data.id)
    if (event?.type !== 'approval/asked') continue
    if (decided.has(event.data.id) || claimed.has(event.data.id)) continue
    if ((event.data.callId ?? null) === (request.callId ?? null)) return event.data.id
  }
  return undefined
}
