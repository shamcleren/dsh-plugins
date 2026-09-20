/** Explicit Codex delegation creates a visible session instead of a hidden one-shot. */
import type { Context } from '@deepseek-ai/cordis'
import type { SessionRequestId } from '@deepseek-ai/dsh-api-session-controller'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { CODEX_PROVIDER, NATIVE_MODEL } from './adapter.js'
import type { CodexBridge } from './bridge.js'

export function registerDelegate(ctx: Context, bridge: CodexBridge, origin: () => string, sessionController: () => Context['sessionController'] | undefined): void {
  ctx.tools.register(defineTool({
    name: 'codex_delegate',
    description: 'Create a visible Codex session for one self-contained task and wait for its first turn. Use only when the human explicitly asks to delegate to Codex. The session remains open for follow-up.',
    parameters: {
      task: { type: 'string', required: true, description: 'Self-contained task and expected outcome. The Codex session does not inherit this conversation.' },
      cwd: { type: 'string', description: 'Absolute workspace. Defaults to the current session workspace.' },
    },
    output: { schema: { type: 'object', additionalProperties: false, properties: { result: { type: 'string', required: true } } }, render: (_args: unknown, value: { result: string }) => [{ type: 'text' as const, text: value.result }] },
    async execute(args, exec) {
      const task = typeof args.task === 'string' ? args.task.trim() : ''
      if (!task) throw new Error('codex_delegate requires a task')
      const cwd = (typeof args.cwd === 'string' && args.cwd) || exec.agent?.session.header.cwd
      if (!cwd) throw new Error('codex_delegate requires a workspace')
      exec.signal.throwIfAborted()
      const controller = sessionController()
      if (!controller) throw new Error('codex_delegate requires the session controller')
      const created = await controller.create({ cwd })
      const sessionId = String(created.sessionId)
      await bridge.remember(sessionId)
      await controller.selectModel({ sessionId: created.sessionId, provider: CODEX_PROVIDER, model: NATIVE_MODEL })
      await controller.rename({ sessionId: created.sessionId, title: 'Codex' }).catch(() => {})
      const lifetime = new AbortController()
      const stop = () => lifetime.abort()
      exec.signal.addEventListener('abort', stop, { once: true })
      const finished = bridge.waitForTurn(sessionId, lifetime.signal)
      let end: Awaited<ReturnType<CodexBridge['waitForTurn']>>
      try {
        await controller.prompt({ requestId: crypto.randomUUID() as SessionRequestId, sessionId: created.sessionId, mode: 'queue', content: [{ type: 'text', text: task }] }, exec.signal)
        end = await finished
      } catch (error) {
        lifetime.abort()
        throw error
      } finally {
        exec.signal.removeEventListener('abort', stop)
      }
      return { result: ['Codex 会话：' + sessionId, origin() + '/#session=' + encodeURIComponent(sessionId), end.status === 'completed' ? '首轮已完成，过程和后续追问都在该会话中。' : '首轮结束：' + end.status + (end.error ? ' ' + end.error : '')].join('\n') }
    },
  }))
}
