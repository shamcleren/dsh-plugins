import { Context } from '@deepseek-ai/cordis'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { expect, it } from 'vitest'
import { apply } from '../../src/index.js'

it('admits before reading management RPC and rejects malformed, oversized and foreign requests', async () => {
  const ctx = new Context()
  let serve!: (request: IncomingMessage, response: ServerResponse) => Promise<void>, removed = false
  ctx.provide('connection', { admit: (request: IncomingMessage) => request.headers.origin === 'https://foreign.invalid' ? { rejection: 403 } : request.headers['x-fixture-auth'] === 'yes' ? { peer: {} } : { rejection: 401 } } as never)
  ctx.provide('webServer', { host: '127.0.0.1', register(route: { handler: typeof serve }) { serve = route.handler; return () => { removed = true } } } as never)
  await ctx.plugin({ apply })
  ctx.imHub.register({ id: 'fixture', capabilities: ['text'], state: () => ({ enabled: false, status: 'disabled', accounts: 0 }) })
  const server = createServer((request, response) => { void serve(request, response) })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('Missing test server')
  const url = `http://127.0.0.1:${address.port}/im/state`, headers = { 'content-type': 'application/json', 'x-fixture-auth': 'yes' }
  const body = JSON.stringify({ type: 'client-request', rpcId: 'fixture', method: 'state', payload: {} })
  try {
    expect((await fetch(url, { method: 'POST', body })).status).toBe(401)
    expect((await fetch(url, { method: 'POST', body, headers: { ...headers, origin: 'https://foreign.invalid' } })).status).toBe(403)
    expect((await (await fetch(url, { method: 'POST', body, headers })).json()).result.value[0].id).toBe('fixture')
    expect((await fetch(url, { method: 'POST', body: '{', headers })).status).toBe(400)
    expect((await fetch(url, { method: 'POST', body: body.replace('"state"', '"configure"'), headers })).status).toBe(400)
    expect((await fetch(url, { method: 'POST', body: 'x'.repeat(8193), headers })).status).toBe(413)
    expect((await fetch(url + '/unknown', { method: 'POST', body, headers })).status).toBe(404)
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); await ctx.fiber.dispose() }
  expect(removed).toBe(true)
})
