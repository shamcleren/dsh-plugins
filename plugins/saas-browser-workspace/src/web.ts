import type { Context } from '@deepseek-ai/cordis'
import type { ConnectionRpcHandler } from '@deepseek-ai/dsh-client-connection'
import { clientRequestSchema } from '@deepseek-ai/dsh-client-connection'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type { IncomingMessage, ServerResponse } from 'node:http'

/** rc.5's RPC registry loses the caller's webServer scope; use its public Web route and admission APIs. */
export function registerRpc(ctx: Context, channel: string, handler: ConnectionRpcHandler): void {
  ctx.effect(() => ctx.webServer.register({ kind: 'prefix', path: channel, handler: async (request, response) => {
    const admission = ctx.connection.admit(request)
    if ('rejection' in admission) { response.writeHead(admission.rejection); response.end(); return }
    if (admission.peer.principal.kind !== 'owner') { response.writeHead(403); response.end(); return }
    const method = new URL(request.url ?? '/', 'http://127.0.0.1').pathname.slice(channel.length + 1)
    if (request.method !== 'POST' || !/^[a-zA-Z]+$/.test(method)) { response.writeHead(404); response.end(); return }
    if (request.headers['content-type']?.split(';')[0]?.trim() !== 'application/json') { response.writeHead(415); response.end(); return }
    const abort = new AbortController()
    const onAbort = () => abort.abort()
    request.once('aborted', onAbort)
    let rpcId = 'invalid-request'
    try {
      let size = 0; const chunks: Buffer[] = []
      for await (const chunk of request) {
        const bytes = Buffer.from(chunk); size += bytes.length
        if (size > 64 * 1024) { response.writeHead(413); response.end(); return }
        chunks.push(bytes)
      }
      const message = clientRequestSchema.parse(JSON.parse(Buffer.concat(chunks).toString('utf8')))
      rpcId = message.rpcId
      if (message.method !== method) throw new Error('invalid-method')
      send(response, { type: 'server-response', rpcId, result: await handler(method, message.payload, abort.signal, admission.peer) })
    } catch { send(response, { type: 'server-response', rpcId, result: { ok: false, error: { code: 'invalid-request', message: 'invalid-request', details: {} } } }) }
    finally { request.removeListener('aborted', onAbort) }
  } }), 'saas-workspace: authenticated Web RPC')
}
function send(response: ServerResponse, value: unknown): void {
  response.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' }); response.end(JSON.stringify(value))
}
export function registerEvidence(ctx: Context, handler: (request: IncomingMessage, response: ServerResponse) => Promise<void>): void {
  ctx.effect(() => ctx.webServer.register({ kind: 'exact', path: '/api/saas-workspace/evidence', handler: async (request, response) => {
    const admission = ctx.connection.admit(request)
    if ('rejection' in admission) { response.writeHead(admission.rejection); response.end(); return }
    if (admission.peer.principal.kind !== 'owner') { response.writeHead(403); response.end(); return }
    if (request.method !== 'GET') { response.writeHead(405); response.end(); return }
    await handler(request, response)
  } }), 'saas-workspace: authenticated evidence')
}
