import { pathToFileURL } from 'node:url'
import { join } from 'node:path'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-api-session-controller'
import type {} from '@deepseek-ai/dsh-workspace'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { Run } from './ui-contract.js'
import { zh, agentReasonKey, errorKey, type LocaleKey } from './client/locales.js'

export interface ScanSession {
  start(run: Run, cwd: string, signal: AbortSignal): Promise<string>
  publish(id: string, run: Run): Promise<void>
}
const phaseKey = (phase: Run['phase']): LocaleKey => phase === 'baseline' ? 'baselinePhase' : phase === 'report' ? 'reportPhase' : phase
/**
 * DSH lists a session and renders its transcript only after a first turn. The
 * trigger opens that turn; `admits` lets the pre-step hook empty the first step,
 * which the native loop skips, so the turn completes without a model request
 * and the trigger itself is never written to the transcript.
 */
export function firstTurnTrigger(name: string) {
  const message = createUserMessage({ source: { kind: 'security-scan' }, content: [{ type: 'text', text: name }] })
  return { message, admits: (messages: ReadonlyArray<{ id: string }>) => messages.some(item => item.id === message.id) }
}
/** Host-owned ordinary sessions; progress is plugin context, never a model prompt. */
export function scanSession(native: Context): ScanSession {
  const sessions = native.sessions
  return {
    async start(run, cwd, signal) {
      const trigger = firstTurnTrigger(run.config.name)
      const cleanup: Array<() => void> = []
      const handle = await native.agents.create({
        sessionId: SessionId('security-' + run.id), meta: { cwd }, signal,
        setup: agentCtx => { cleanup.push(agentCtx.on('agent/pre-step', async (payload, next) => trigger.admits(payload.messages) ? { kind: 'enter', messages: [] } : next())) },
      })
      try {
        handle.agent.followup(trigger.message)
        await handle.agent.whenIdle()
        const session = handle.agent.session
        if (!session.snapshotEvents().some(event => event.type === 'turn/start')) throw new Error('scan-session-unavailable')
        const workspace = await native.workspaceRegistry.create(cwd)
        await workspace.attachSession(session.id)
        // The session is committed; an optional title failure must not lose its identity.
        await native.sessionController.rename({ sessionId: session.id, title: zh.entry + ' · ' + run.config.name }).catch(() => {})
        return session.id
      } finally { for (const dispose of cleanup.splice(0).reverse()) dispose() }
    },
    async publish(id, run) {
      const session = sessions.get(SessionId(id))
      if (!session) throw new Error('scan-session-unavailable')
      const last = run.agent?.events.at(-1)
      const summary = zh.entry + ' · ' + run.config.name + ' · ' + zh[run.status] + ' · ' + zh[phaseKey(run.phase)] + (run.agent && last ? ' · ' + run.agent.steps + ' · ' + zh[last.kind] : '')
      const data = {
        runId: run.id, executionSessionId: run.sessionId, task: run.config.name, status: zh[run.status], phase: zh[phaseKey(run.phase)],
        source: run.config.target, findings: run.findings,
        ...(run.agent ? { model: run.agent.provider + '/' + run.agent.model, round: run.agent.steps, reviewed: run.agent.reviewedFindings, eligible: run.agent.eligibleCandidates, outsideSourceReview: run.agent.excludedCandidates,
          activity: last ? zh[last.kind] : undefined, files: last?.files, rejection: last?.code ? zh[errorKey(last.code)] : undefined,
          outcome: run.agent.status === 'incomplete' && run.phase === 'finished' ? zh[agentReasonKey(run.agent.reason)] : undefined } : {}),
        diagnostics: run.diagnostics, error: run.error ? zh[errorKey(run.error)] : undefined,
        report: run.reportId && run.reportRoot ? join(run.reportRoot, run.reportId, 'report.html') : undefined,
      }
      const text = run.phase === 'finished' ? [summary, run.resultSummary ? '已确认 ' + run.resultSummary.confirmed + ' · 待复核 ' + run.resultSummary.pending + ' · 已排除 ' + run.resultSummary.dismissed : '', run.coverage === 'partial' ? zh.coveragePartial : '', data.report ? '[查看 HTML 扫描报告](' + pathToFileURL(data.report).href + ')' : '未生成报告；请查看任务错误与执行轨迹。'].filter(Boolean).join('\n\n') : JSON.stringify(data, null, 2), previous = session.snapshotEvents().at(-1)
      if (previous?.type === 'user/message' && (previous.data.source.kind === 'security-scan' || previous.data.source.kind === 'plugin:security-scan') && previous.data.content.some(block => block.type === 'text' && block.text === text)) return
      session.append('user/message', createUserMessage({ source: { kind: 'security-scan', form: 'notice', summary }, content: [{ type: 'text', text }] }), { surfaceOp: 'append' })
      if (!await sessions.flush(session)) throw new Error('scan-session-unavailable')
    },
  }
}
