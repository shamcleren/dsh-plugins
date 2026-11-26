import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type {} from '@deepseek-ai/dsh-client-connection'
import { clientRequestSchema } from '@deepseek-ai/dsh-client-connection'
import { IMHub } from './hub.js'
import { wecomSessionId } from './contracts.js'
export { IMHub } from './hub.js'
export type { IMAdapter, IMAdapterState, IMAdapterView, IMCapability } from './hub.js'

export const name = 'im'
export function apply(ctx: Context): void {
  const hub = new IMHub(ctx)
  ctx.inject(['connection', 'webServer'], scope => {
    if (scope.webServer.host !== '127.0.0.1') throw new Error('IM management requires a loopback server')
    scope.effect(() => scope.webServer.register({ kind: 'prefix', path: '/im', async handler(request, response) {
      const send = (status: number, body: unknown) => { response.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' }); response.end(JSON.stringify(body)) }
      const admission = scope.connection.admit(request)
      if ('rejection' in admission) { send(admission.rejection, { error: 'forbidden' }); return }
      const path = request.url?.split('?')[0]
      if (request.method !== 'POST' || (path !== '/im/state' && path !== '/im/sessionSource')) { send(404, { error: 'notFound' }); return }
      if (request.headers['content-type']?.split(';')[0] !== 'application/json') { send(415, { error: 'invalidRequest' }); return }
      let size = 0
      const chunks: Buffer[] = []
      try {
        for await (const chunk of request) { const bytes = Buffer.from(chunk as Uint8Array); size += bytes.length; if (size > 8192) { send(413, { error: 'tooLarge' }); return }; chunks.push(bytes) }
        const decoded = clientRequestSchema.safeParse(JSON.parse(Buffer.concat(chunks).toString('utf8')))
        if (!decoded.success || path !== '/im/' + decoded.data.method) { send(400, { error: 'invalidRequest' }); return }
        let value: unknown
        if (path === '/im/sessionSource') {
          if (admission.peer.principal.kind !== 'owner') { send(403, { error: 'forbidden' }); return }
          const id = wecomSessionId.safeParse((decoded.data.payload as { sessionId?: unknown } | null)?.sessionId)
          if (!id.success) { send(400, { error: 'invalidSession' }); return }
          // Older browser bundles still request a header label. Attribution now belongs to each question.
          value = null
        } else value = hub.state()
        send(200, { type: 'server-response', rpcId: decoded.data.rpcId, result: { ok: true, value } })
      } catch { send(400, { error: 'invalidRequest' }) }
    } }), 'IM management RPC')
  })
}
