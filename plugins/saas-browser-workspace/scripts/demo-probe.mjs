// Copied into an isolated profile by demo.mjs. This adapter is a deterministic test driver, not a language model.
import { LlmAdapter, ToolCallId } from '@deepseek-ai/dsh-llm'
import { writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
export const inject = ['connection', 'webServer', 'llm', 'sessions', 'sessionController', 'tools']
export async function apply(ctx) {
  const lifetime = new AbortController()
  ctx.effect(() => () => lifetime.abort())
  class FixtureAdapter extends LlmAdapter {
    providerInfo(id) { return { id, name: 'SaaS 演示（固定流程，无模型调用）' } }
    async listModels(provider) { return [{ provider, id: 'fixture', name: '表单 → 智能体查询' }] }
    async *stream(options) {
      options.signal?.throwIfAborted()
      const last = options.messages.filter(message => message.role !== 'system' && message.role !== 'developer').at(-1)
      if (last?.role === 'user') {
        const text = last.content.filter(block => block.type === 'text').map(block => block.text).join('\n')
        let runId
        if (text.includes('查询条件已提交')) {
          for (const message of [...options.messages].reverse()) {
            if (message.role !== 'tool') continue
            for (const block of message.content) {
              if (block.type !== 'text') continue
              try { const value = JSON.parse(block.text); runId = value.runId ?? value.id } catch {}
              if (runId) break
            }
            if (runId) break
          }
        }
        const args = runId ? { run_id: runId } : text.startsWith('query:') ? { keyword: text.slice(6).trim() } : {}
        yield { type: 'block-end', index: 0, block: { type: 'tool-call', id: ToolCallId(randomUUID()), name: 'saas_query_agents', arguments: JSON.stringify(args) } }
        yield { type: 'finish', reason: { kind: 'tool-calls' } }
      } else {
        let status
        for (const block of last?.content ?? []) { if (block.type === 'text') { try { status = JSON.parse(block.text).status } catch {} } }
        yield { type: 'block-end', index: 0, block: { type: 'text', text: ['succeeded', 'partial'].includes(status) ? '查询已完成，请在右侧 SaaS 工作台查看表格、列表、汇总和原页面截图。当前使用固定流程演示器。' : '查询尚未完成，请在右侧工作台查看当前状态并继续。当前使用固定流程演示器。' } }
        yield { type: 'finish', reason: { kind: 'stop' } }
      }
    }
  }
  ctx.llm.registerAdapter(['saas-demo'], new FixtureAdapter())
  if (!ctx.tools.get('saas_query_agents')) await new Promise((resolve, reject) => {
    const release = ctx.on('tools/change', () => { if (ctx.tools.get('saas_query_agents')) { release(); resolve() } })
    lifetime.signal.addEventListener('abort', () => { release(); reject(new Error('demo stopped')) }, { once: true })
  })
  let audit = Promise.resolve()
  ctx.on('tools/result', (exec, result) => {
    if (exec.name.startsWith('mcp__saas-playwright__') && result.isError) {
      audit = audit.then(() => writeFile(process.env.DSH_DEMO_READY + '.browser-error.json', JSON.stringify({ name: exec.name, error: result.error }), { mode: 0o600 }))
    }
  })
  ctx.on('session/flush', session => { audit = audit.then(() => writeFile(process.env.DSH_DEMO_READY + '.events.json', JSON.stringify(session.snapshotEvents()), { mode: 0o600 })) })
  ctx.effect(() => () => audit)
  const session = await ctx.sessionController.create({ cwd: process.env.DSH_DEMO_WORKDIR })
  await ctx.sessionController.selectModel({ sessionId: session.sessionId, provider: 'saas-demo', model: 'fixture' })
  await ctx.sessionController.prompt({ sessionId: session.sessionId, requestId: randomUUID(), mode: 'queue', content: [{ type: 'text', text: '帮我查询服务市场里的智能体，先用表单补充关键词。' }] }, lifetime.signal)
  await writeFile(process.env.DSH_DEMO_READY, JSON.stringify({ sessionId: session.sessionId, url: ctx.connection.authenticatedUrl('http://127.0.0.1:' + ctx.webServer.port) }), { mode: 0o600 })
}
