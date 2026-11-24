import type { AgentTranslate, AgentLocaleKey } from '../agent-locales.js'
const hints: Record<string, AgentLocaleKey> = {
  'model-auth-required': 'modelAuthHelp', 'agent-turn-failed': 'modelFailureHelp', 'agent-turn-interrupted': 'interruptedHelp',
  'stale-frame': 'frameChanged',
  'stale-approval': 'approvalStale', 'approval-pending': 'approvalContext', 'approval-result-uncertain': 'approvalUncertain',
  'approval-continuation-failed': 'approvalContinuation',
  'workspace-busy': 'busyHelp', 'stale-question': 'staleQuestion', 'invalid-answers': 'requiredHelp',
  'stale-observation': 'stale', 'page-changed-observe-again': 'stale', 'unknown-control': 'stale', 'record-unavailable': 'stale',
  'stale-handoff': 'staleHandoff', 'login-required': 'loginRequired', 'takeover-required': 'staleHandoff',
  'browser-not-ready': 'browserNotReady', 'not-configured': 'notConfigured', 'read-only': 'readOnlyHelp',
  'select-first': 'selectFirst', 'execution-not-authorized': 'notAuthorized', 'fill-not-authorized': 'notAuthorized',
  'click-not-authorized': 'notAuthorized', 'navigation-not-authorized': 'notAuthorized',
  'execution-control-changed': 'stale', 'execution-control-unavailable': 'stale',
  'execution-in-progress': 'busyHelp', 'execution-uncertain': 'uncertainHelp', 'submission-uncertain': 'uncertainHelp',
  'interrupted-execution': 'uncertainHelp', 'execution-page-changed': 'uncertainHelp', 'execution-scope-unavailable': 'uncertainHelp',
  'result-timeout': 'uncertainHelp', 'execution-journal-unavailable': 'journalHelp',
}
export function errorHint(code: string | undefined, t: AgentTranslate): string { return t(code && hints[code] || 'error') }
