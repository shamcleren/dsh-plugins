/** Codex sessions keep DSH's conversation shell and deliberately have no DSH tools to execute. */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-system-prompt'
import type {} from '@deepseek-ai/dsh-tools'
import { CodexAdapter, CODEX_PROVIDER } from './adapter.js'
import { currentBridge } from './owner.js'

export const name = 'codex-session-preset'
export const inject = ['tools', 'systemPrompt']

export function apply(ctx: Context): void {
  const names = ctx.tools.schemas().map(tool => tool.name)
  if (names.length) ctx.tools.restrict({ deny: names })
  ctx.systemPrompt.section({ name: 'codex-session', order: 0, text: '这是一个 Codex 会话。用户消息由 Codex 处理。用户显式调用的 skill 和插件说明会作为文本交给 Codex；不要调用或模仿 DSH 工具。Codex 自己的命令、文件修改和审批会显示在本会话中。' })
  const bound = currentBridge()
  if (!bound) return
  ctx.inject(['llm'], llmCtx => {
    if (llmCtx.llm.listProviders().some(provider => provider.id === CODEX_PROVIDER)) return
    llmCtx.llm.registerAdapter([CODEX_PROVIDER], new CodexAdapter(bound.bridge, bound.cwdFor))
  })
}
