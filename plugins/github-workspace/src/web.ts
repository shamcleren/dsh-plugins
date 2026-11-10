import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
import { clientRequestSchema } from '@deepseek-ai/dsh-client-connection'
import { WorkspaceError } from './types.js'
import type { WorkspaceService } from './service.js'

export function registerRpc(ctx: Context, service: Pick<WorkspaceService, 'request'>): void {
  const send = (response: ServerResponse, code: number, body: unknown) => {
    response.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store' }); response.end(JSON.stringify(body))
  }
  async function handler(request: IncomingMessage, response: ServerResponse) {
    const admission = ctx.connection.admit(request)
    if ('rejection' in admission) { send(response, admission.rejection, { error: 'forbidden' }); return }
    const endpoint = new URL(request.url ?? '/', 'http://127.0.0.1').pathname.slice('/github-workspace/'.length)
    if (request.method !== 'POST' || !/^[a-zA-Z]+$/.test(endpoint)) { send(response, 404, { error: 'notFound' }); return }
    if (request.headers['content-type']?.split(';')[0]?.trim().toLowerCase() !== 'application/json') { send(response, 415, { error: 'invalidRequest' }); return }
    const abort = new AbortController()
    request.once('aborted', () => abort.abort())
    let size = 0, text = '', rpcId = 'invalid-request'
    try {
      const chunks: Buffer[] = []
      for await (const chunk of request) {
        const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array)
        size += bytes.length
        if (size > 64 * 1024) { send(response, 413, { error: 'tooLarge' }); return }
        chunks.push(bytes)
      }
      text = Buffer.concat(chunks).toString('utf8')
      const decoded = clientRequestSchema.safeParse(JSON.parse(text))
      if (!decoded.success) throw new WorkspaceError('invalidRequest')
      rpcId = decoded.data.rpcId
      if (decoded.data.method !== endpoint) throw new WorkspaceError('invalidRequest')
      const value = await service.request(endpoint, decoded.data.payload, abort.signal)
      send(response, 200, { type: 'server-response', rpcId, result: { ok: true, value } })
    } catch (error) {
      const code = error instanceof WorkspaceError ? error.code : error instanceof SyntaxError ? 'invalidRequest' : 'commandFailed'
      // Command output may contain credentials or private repository details.
      send(response, 200, { type: 'server-response', rpcId, result: { ok: false, error: { code, message: code, details: {} } } })
    }
  }
  ctx.effect(() => ctx.webServer.register({ kind: 'prefix', path: '/github-workspace', handler }), 'github-workspace: authenticated RPC')
}
