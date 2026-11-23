// Uses the host's configured LLM adapter. No generated replies or tool calls live here.
import { readFile, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { parseCredentialsDocument } from '@deepseek-ai/dsh-credentials-local'
export const inject = ['connection', 'webServer', 'llm', 'credentials', 'sessions', 'agents', 'sessionController', 'tools']
export async function apply(ctx) {
  const abort = new AbortController()
  ctx.effect(() => () => abort.abort())
  const route = JSON.parse(await readFile(process.env.DSH_SAAS_MODEL_CONFIG, 'utf8'))
  if (route.credentialFile && route.config.apiKeyEnv) {
    const doc = parseCredentialsDocument(await readFile(route.credentialFile, 'utf8'), route.credentialFile)
    const secret = doc.refs.get(route.config.apiKeyEnv)
    if (!secret) throw new Error('Configured model credential is missing')
    // Only this reference is imported through the dedicated credential service.
    await ctx.credentials.set(credentialRef(route.config.apiKeyEnv), secret)
  }
  if (!ctx.tools.get('saas_browser')) await new Promise((resolve, reject) => {
    const release = ctx.on('tools/change', () => { if (ctx.tools.get('saas_browser')) { release(); resolve() } })
    abort.signal.addEventListener('abort', () => { release(); reject(new Error('stopped')) }, { once: true })
  })
  ctx.on('agent/created', ({ agent }) => {
    agent.ctx.effect(() => agent.ctx.tools.restrict({ allow: ['saas_browser', 'saas_present', 'saas_ask'] }), 'demo: browser task capabilities')
  })
  let audit = Promise.resolve()
  ctx.on('session/flush', session => {
    audit = audit.then(() => writeFile(process.env.DSH_DEMO_READY + '.events.json', JSON.stringify(session.snapshotEvents()), { mode: 0o600 }))
  })
  ctx.effect(() => () => audit)
  const session = await ctx.sessionController.create({ cwd: process.env.DSH_DEMO_WORKDIR })
  await ctx.sessionController.selectModel({ sessionId: session.sessionId, provider: route.provider, model: route.model })
  await ctx.sessionController.rename({ sessionId: session.sessionId, title: process.env.DSH_SAAS_SESSION_TITLE || 'SaaS · 查询与配置查看' })
  await writeFile(process.env.DSH_DEMO_READY, JSON.stringify({ sessionId: session.sessionId, url: ctx.connection.authenticatedUrl(ctx.webServer.getOrigin()), provider: route.provider, model: route.model }), { mode: 0o600 })
  if (process.env.DSH_SAAS_PROMPT) await ctx.sessionController.prompt({ sessionId: session.sessionId, requestId: randomUUID(), mode: 'queue', content: [{ type: 'text', text: process.env.DSH_SAAS_PROMPT }] }, abort.signal)
}
