/** Map DSH's one-shot approval vocabulary onto Codex app-server decisions. */
export type CodexDecision = 'accept' | 'decline' | 'cancel'
export type DshOutcome = 'allowed-once' | 'rejected' | 'cancelled' | 'unavailable'

/** Never synthesize a session-wide or policy-amendment grant. */
export function decisionFor(outcome: DshOutcome): CodexDecision {
  if (outcome === 'allowed-once') return 'accept'
  if (outcome === 'cancelled') return 'cancel'
  return 'decline'
}

export const ELICITATION = 'mcpServer/elicitation/request'

/**
 * Requests DSH can answer with accept, decline, or cancel alone. An elicitation that
 * asks for field values needs text DSH approval cannot carry, so it is not one of them.
 */
export function nativelyApprovable(method: string, params: Record<string, unknown>): boolean {
  if (method.endsWith('requestApproval')) return true
  return method === ELICITATION && !requestsFields(params)
}

function requestsFields(params: Record<string, unknown>): boolean {
  const schema = isRecord(params.requestedSchema) ? params.requestedSchema : undefined
  const properties = schema && isRecord(schema.properties) ? schema.properties : undefined
  return properties !== undefined && Object.keys(properties).length > 0
}

export function approvalPrompt(method: string, params: Record<string, unknown>): { toolName: string; reason: string } {
  const command = text(params.command)
  const reason = text(params.reason)
  if (method === 'item/commandExecution/requestApproval') return { toolName: 'codex.command', reason: command || reason || 'Codex wants to run a command' }
  if (method === 'item/fileChange/requestApproval') return { toolName: 'codex.fileChange', reason: reason || 'Codex wants to change files' }
  if (method === 'item/permissions/requestApproval') return { toolName: 'codex.permissions', reason: reason || 'Codex wants additional permissions' }
  if (method === ELICITATION) return { toolName: 'codex.mcpElicitation', reason: text(params.message) || reason || 'Codex MCP wants a confirmation' }
  return { toolName: 'codex.request', reason: reason || method }
}

export function approvalResponse(method: string, params: Record<string, unknown>, decision: CodexDecision): Record<string, unknown> {
  if (method === 'item/permissions/requestApproval') {
    const requested = isRecord(params.permissions) ? params.permissions : {}
    return { permissions: decision === 'accept' ? requested : {}, scope: 'turn' }
  }
  // MCP elicitation carries the same three outcomes; an accepted confirmation has no field values.
  if (method === ELICITATION) return decision === 'accept' ? { action: 'accept', content: {} } : { action: decision }
  return { decision }
}

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}
