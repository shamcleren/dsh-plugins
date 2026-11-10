import { Context } from '@deepseek-ai/cordis'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { expect, it, vi } from 'vitest'
import { registerRpc } from '../src/web.js'

it('admits HTTP before dispatch, validates envelopes and contains private command failures', async () => {
  const ctx = new Context(), service = { request: vi.fn(async () => ({ value: 'fixture' })) }
  let serve!: (request: IncomingMessage, response: ServerResponse) => Promise<void>, removed = false
  ctx.provide('connection', { admit: (request: IncomingMessage) => request.headers['x-fixture-auth'] === 'yes' ? { peer: {} } : { rejection: 401 } } as never)
  ctx.provide('webServer', { register(route: { handler: typeof serve }) { serve = route.handler; return () => { removed = true } } } as never)
  await ctx.plugin({ apply(inner: Context) { registerRpc(inner, service) } })
  const server = createServer((req, res) => { void serve(req, res) })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('No server')
  const url = `http://127.0.0.1:${address.port}/github-workspace/state`
  const body = JSON.stringify({ type: 'client-request', rpcId: 'fixture', method: 'state', payload: {} })
  try {
    expect((await fetch(url, { method: 'POST', body, headers: { 'content-type': 'application/json' } })).status).toBe(401)
    expect(service.request).not.toHaveBeenCalled()
    const headers = { 'content-type': 'application/json', 'x-fixture-auth': 'yes' }
    expect((await (await fetch(url, { method: 'POST', body, headers })).json()).result).toEqual({ ok: true, value: { value: 'fixture' } })
    const mismatch = JSON.stringify({ type: 'client-request', rpcId: 'fixture', method: 'push', payload: {} })
    expect((await (await fetch(url, { method: 'POST', body: mismatch, headers })).json()).result.error.code).toBe('invalidRequest')
    expect((await fetch(url, { method: 'POST', body: 'x'.repeat(70_000), headers })).status).toBe(413)
    service.request.mockRejectedValueOnce(new Error('private-token-fixture'))
    const text = await (await fetch(url, { method: 'POST', body, headers })).text()
    expect(text).not.toContain('private-token-fixture'); expect(JSON.parse(text).result.error.code).toBe('commandFailed')
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); await ctx.fiber.dispose() }
  expect(removed).toBe(true)
})
