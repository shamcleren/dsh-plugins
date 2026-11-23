import { latestAgentState, type AgentRemote, type AgentState } from '../agent-contract.js'

export interface WorkspaceSnapshot { state?: AgentState | undefined; connection: 'connecting' | 'connected' | 'disconnected' }
/** One request chain per remote/session, shared by the panel and the browser overlay. */
export function createWorkspaceStore(remote: AgentRemote, sessionId: string, interval = 750) {
  let snapshot: WorkspaceSnapshot = { connection: 'connecting' }
  const listeners = new Set<() => void>()
  let active: AbortController | undefined, timer: ReturnType<typeof setTimeout> | undefined
  function publish(next: WorkspaceSnapshot) {
    if (next.state === snapshot.state && next.connection === snapshot.connection) return
    snapshot = next; listeners.forEach(listener => listener())
  }
  async function poll(abort: AbortController): Promise<void> {
    try {
      const next = await remote.state(sessionId, abort.signal)
      if (!abort.signal.aborted) publish({ state: latestAgentState(snapshot.state, next), connection: 'connected' })
    } catch {
      if (!abort.signal.aborted) publish({ state: snapshot.state, connection: 'disconnected' })
    }
    if (!abort.signal.aborted) timer = setTimeout(() => { void poll(abort) }, interval)
  }
  function start() { active = new AbortController(); void poll(active) }
  function stop() { active?.abort(); active = undefined; clearTimeout(timer) }
  return {
    getSnapshot: () => snapshot,
    subscribe(listener: () => void) {
      listeners.add(listener)
      if (listeners.size === 1) start()
      return () => { listeners.delete(listener); if (!listeners.size) stop() }
    },
    retry() { stop(); if (listeners.size) start() },
  }
}
const stores = new WeakMap<AgentRemote, Map<string, ReturnType<typeof createWorkspaceStore>>>()
export function workspaceStore(remote: AgentRemote, sessionId: string) {
  let sessions = stores.get(remote)
  if (!sessions) { sessions = new Map(); stores.set(remote, sessions) }
  let store = sessions.get(sessionId)
  if (!store) { store = createWorkspaceStore(remote, sessionId); sessions.set(sessionId, store) }
  return store
}
