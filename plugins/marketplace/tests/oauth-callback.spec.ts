import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, expect, it, vi } from 'vitest'
import { OAuthCallbackListener } from '../src/oauth-callback.ts'

afterEach(() => { vi.useRealTimers() })

async function portReservation() {
  const server = createServer((_req, res) => { res.end('existing service') })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  return { server, port: (server.address() as AddressInfo).port,
    close: () => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())) }
}

it('refuses an occupied callback port without contacting or stopping its owner', async () => {
  const reservation = await portReservation()
  const listener = new OAuthCallbackListener(vi.fn(), `http://127.0.0.1:${reservation.port}/callback`)
  try {
    await expect(listener.start()).rejects.toThrow('Close the application')
    expect(await (await fetch(`http://127.0.0.1:${reservation.port}`)).text()).toBe('existing service')
  } finally { await listener.dispose(); await reservation.close() }
})

it('serves the callback on loopback and releases its port after completion', async () => {
  const reservation = await portReservation()
  await reservation.close()
  const uri = `http://127.0.0.1:${reservation.port}/callback`
  const listener = new OAuthCallbackListener(async (_req, res) => { res.end('authorized'); return true }, uri)
  try {
    await Promise.all([listener.start(), listener.start()])
    expect((await fetch(uri.replace('/callback', '/unrelated'))).status).toBe(404)
    expect(await (await fetch(uri)).text()).toBe('authorized')
    const probe = createServer()
    try {
      await new Promise<void>((resolve, reject) => { probe.once('error', reject); probe.listen(reservation.port, '127.0.0.1', resolve) })
    } finally { await new Promise<void>(resolve => probe.close(() => resolve())) }
  } finally { await listener.dispose() }
})

it('closes an abandoned listener on timeout and refuses starts after disposal', async () => {
  const reservation = await portReservation()
  await reservation.close()
  const listener = new OAuthCallbackListener(vi.fn(), `http://127.0.0.1:${reservation.port}/callback`)
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  await listener.start()
  await vi.advanceTimersByTimeAsync(10 * 60 * 1000)
  await listener.dispose()
  await expect(listener.start()).rejects.toThrow('stopped')
  expect(vi.getTimerCount()).toBe(0)
})
