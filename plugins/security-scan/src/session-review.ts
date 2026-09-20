import type { Agent } from '@deepseek-ai/dsh-agent'
import type { UserMessage, TurnEndReason } from '@deepseek-ai/dsh-session'

/** Queue one owned turn on a borrowed Agent. Never create/dispose the user's session. */
export async function reviewInSession(agent: Agent, message: UserMessage, setup: () => void, release: () => void, signal: AbortSignal, onEnd: (reason: TurnEndReason) => void): Promise<void> {
  signal.throwIfAborted()
  let turn: number | undefined, setupFailed = false, settled = false
  let setupError: unknown
  const disposers: Array<() => void> = []
  let resolve!: () => void, reject!: (error: unknown) => void
  const completed = new Promise<void>((yes, no) => { resolve = yes; reject = no })
  const finish = (error?: unknown) => {
    if (settled) return
    settled = true
    release()
    if (error) reject(error); else resolve()
  }
  const cancel = () => {
    if (settled) return
    if (turn !== undefined) agent.cancel({ kind: 'hook', reason: 'security-scan-cancelled' }, { keepInbox: true })
    else { agent.inbox.remove(message.id); finish(signal.reason ?? new Error('scan-cancelled')) }
  }
  try {
    disposers.push(agent.ctx.on('agent/inbox/claimed', event => {
      if (event.message.id !== message.id) return
      turn = event.turn
      // Claim is synchronous and precedes system-prompt/tool assembly. Pre-step
      // is too late: its first model request would advertise the previous tools.
      try { signal.throwIfAborted(); setup() }
      catch (error) { setupFailed = true; setupError = error; release() }
    }))
    disposers.push(agent.ctx.on('agent/inbox/discarded', event => { if (event.message.id === message.id) finish(new Error('scan-prompt-discarded')) }))
    disposers.push(agent.ctx.on('agent/disposed', () => finish(new Error('scan-session-unavailable'))))
    disposers.push(agent.ctx.on('agent/pre-step', async (event, next) => {
      if (event.turn === turn && setupFailed) return { kind: 'reject' }
      return next()
    }, { prepend: true }))
    disposers.push(agent.ctx.on('session/event', (_session, entry) => {
      if (entry.type !== 'turn/end' || entry.data.turn !== turn || settled) return
      onEnd(entry.data.reason)
      // Unwind before the driver can claim a following ordinary user prompt.
      finish(setupFailed ? setupError : undefined)
    }))
    signal.addEventListener('abort', cancel, { once: true })
    agent.followup(message)
    await completed
  } finally {
    signal.removeEventListener('abort', cancel)
    for (const dispose of disposers.reverse()) dispose()
    release()
  }
}
