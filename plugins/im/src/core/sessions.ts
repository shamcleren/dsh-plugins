import { randomUUID } from 'node:crypto'
import { HostApiError, unwrap, type HostApiProxy } from './host-api.js'

const missingSessions = new Set(['session/not-found', 'session-not-found', 'SESSION_QUERY_SESSION_NOT_FOUND'])
const incompatibleSessions = new Set(['session-conflict', 'session/conflict', 'session/cwd-conflict', 'agent-preset-conflict', 'agent-preset/conflict'])

/** `sessionController.create` may mint a different id; only its returned identity is authoritative. */
export async function ensureConversationSession(options: {
  api: { workspace: Pick<HostApiProxy['workspace'], 'list'>; sessions: Pick<HostApiProxy['sessions'], 'history'> }
  key: string
  requested: string
  defaultWorkspaceId: string
  bindings: { set(key: string, sessionId: string): Promise<void> }
  create(sessionId: string, workspaceId: string): Promise<string>
}): Promise<string> {
  const roster = unwrap(await options.api.workspace.list({ rpcId: `im-workspaces-${randomUUID()}`, payload: {} }))
  const owner = roster.items.find(workspace => workspace.sessionIds.includes(options.requested))
  const archived = roster.archivedSessionIds.includes(options.requested)
  if (owner && !archived) {
    const history = await options.api.sessions.history({ rpcId: `im-history-${randomUUID()}`, payload: { sessionId: options.requested, maxMessages: 1 } })
    if (history.result.ok) return options.requested
    if (!missingSessions.has(history.result.error.code)) unwrap(history)
  }
  const workspaceId = owner?.workspaceId ?? options.defaultWorkspaceId
  const namespace = /^session-(wechat|wecom)-/.exec(options.requested)?.[1] ?? 'im'
  const fresh = () => `session-${namespace}-${randomUUID().replaceAll('-', '')}`
  const requested = archived ? fresh() : options.requested
  let actual: string
  try { actual = await options.create(requested, workspaceId) }
  catch (error) {
    if (!(error instanceof HostApiError) || !incompatibleSessions.has(error.code)) throw error
    actual = await options.create(fresh(), workspaceId)
  }
  if (actual !== options.requested) await options.bindings.set(options.key, actual)
  return actual
}
