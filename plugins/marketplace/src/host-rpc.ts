import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
import { clientRequestSchema } from '@deepseek-ai/dsh-client-connection'

const MAX_BODY_BYTES = 1024 * 1024

type RpcHandler = (method: string, payload: unknown, signal: AbortSignal) => unknown | Promise<unknown>

/** Register a custom Connection-compatible channel on the consuming plugin fiber. */
export function registerHostRpc(ctx: Context, channel: string, handler: RpcHandler): void {
  ctx.effect(() => ctx.webServer.register({
    kind: 'prefix',
    path: channel,
    handler: (request, response) => serveRpc(ctx, channel, handler, request, response),
  }), `host-rpc: ${channel}`)
}

async function serveRpc(ctx: Context, channel: string, handler: RpcHandler, request: IncomingMessage, response: ServerResponse): Promise<void> {
  const rejection = ctx.connection.requestRejection(request)
  if (rejection !== undefined) return send(response, rejection, rejection === 401 ? 'unauthorized' : 'forbidden')
  const endpoint = endpointFrom(channel, request.url)
  if (request.method !== 'POST' || endpoint === undefined) return send(response, 404, 'not found')
  if (request.headers['content-type']?.split(';', 1)[0]?.trim().toLowerCase() !== 'application/json') return send(response, 415, 'content type must be application/json')
  const body = await readBody(request, response)
  if (body === undefined) return
  let decoded: unknown
  try {
    decoded = JSON.parse(body)
  } catch {
    return send(response, 400, 'body is not JSON')
  }
  const envelope = clientRequestSchema.safeParse(decoded)
  if (!envelope.success) return sendJson(response, 400, rpcResponse(rpcIdFrom(decoded), { ok: false, error: { code: 'gateway/bad-request', message: 'invalid client-request message', details: { issues: envelope.error.issues } } }))
  if (envelope.data.method !== endpoint) return sendJson(response, 200, rpcResponse(envelope.data.rpcId, { ok: false, error: { code: 'gateway/bad-request', message: 'method does not match endpoint', details: { issues: [] } } }))
  const abort = new AbortController()
  request.once('aborted', () => abort.abort())
  try {
    sendJson(response, 200, rpcResponse(envelope.data.rpcId, await handler(endpoint, envelope.data.payload, abort.signal)))
  } catch (error) {
    send(response, 500, `handler failure: ${String(error)}`)
  }
}

async function readBody(request: IncomingMessage, response: ServerResponse): Promise<string | undefined> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    size += bytes.length
    if (size > MAX_BODY_BYTES) {
      send(response, 413, 'request body too large')
      return
    }
    chunks.push(bytes)
  }
  return Buffer.concat(chunks).toString('utf8')
}

function endpointFrom(channel: string, rawUrl: string | undefined): string | undefined {
  if (!rawUrl) return
  const pathname = new URL(rawUrl, 'http://localhost').pathname
  if (!pathname.startsWith(channel + '/')) return
  const endpoint = pathname.slice(channel.length + 1)
  if (!endpoint || endpoint.split('/').some(segment => !/^[A-Za-z0-9_$.-]+$/.test(segment))) return
  return endpoint
}

function rpcIdFrom(value: unknown): string {
  return typeof value === 'object' && value !== null && typeof Reflect.get(value, 'rpcId') === 'string'
    ? Reflect.get(value, 'rpcId') as string
    : 'invalid-request'
}

function rpcResponse(rpcId: string, result: unknown): object {
  return { type: 'server-response', rpcId, result }
}

function send(response: ServerResponse, status: number, body: string): void {
  response.writeHead(status, { 'content-type': 'text/plain; charset=utf-8' })
  response.end(body)
}

function sendJson(response: ServerResponse, status: number, body: object): void {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  response.end(JSON.stringify(body))
}
