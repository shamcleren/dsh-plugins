import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, expect, it } from 'vitest'
import { mergeDynamic, scanDynamic } from '../src/dynamic.js'
import type { Report } from '../src/report.js'

type Handler = (request: IncomingMessage, response: ServerResponse) => void
const servers: Array<ReturnType<typeof createServer>> = []
afterEach(async () => { await Promise.all(servers.splice(0).map(server => new Promise(resolve => server.close(resolve)))) })
const signal = (): AbortSignal => new AbortController().signal
async function serve(handler: Handler): Promise<{ url: string; requests: Array<{ method: string; path: string; origin?: string }> }> {
  const requests: Array<{ method: string; path: string; origin?: string }> = []
  const server = createServer((request, response) => { requests.push({ method: request.method!, path: request.url!, ...(request.headers.origin ? { origin: request.headers.origin } : {}) }); handler(request, response) })
  servers.push(server)
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  return { url: 'http://127.0.0.1:' + (server.address() as AddressInfo).port + '/', requests }
}
const insecure: Handler = (request, response) => {
  if (request.url === '/') {
    response.setHeader('content-type', 'text/html'); response.setHeader('server', 'nginx/1.18.0'); response.setHeader('set-cookie', 'session=super-secret-cookie-value; Path=/')
    if (request.headers.origin) { response.setHeader('access-control-allow-origin', request.headers.origin); response.setHeader('access-control-allow-credentials', 'true') }
    response.end('<html><title>App</title><body>private page body</body></html>'); return
  }
  if (request.url === '/.git/HEAD') { response.end('ref: refs/heads/main\n'); return }
  response.statusCode = 404; response.end('Traceback (most recent call last):\n  File "app.py", line 1')
}

it('reports header, cookie, CORS and exposed-file risks without storing bodies or cookie values', async () => {
  const service = await serve(insecure)
  const result = await scanDynamic(service.url, signal())
  const rules = result.findings.map(item => item.rule)
  expect(rules).toEqual(expect.arrayContaining(['dynamic.header-csp', 'dynamic.header-nosniff', 'dynamic.header-clickjacking', 'dynamic.version-disclosure', 'dynamic.cookie-httponly', 'dynamic.cookie-samesite', 'dynamic.git-exposed', 'dynamic.cors-credentials', 'dynamic.debug-error']))
  expect(result.findings.find(item => item.rule === 'dynamic.cors-credentials')?.severity).toBe('high')
  // Loopback http is expected in development; transport findings belong to the deployed environment.
  expect(rules).not.toContain('dynamic.cleartext')
  expect(result.engine).toMatchObject({ name: 'http', status: 'completed' })
  expect(result.findings.every(item => item.engine === 'http' && item.status === 'needs-review' && item.endpoint?.method === 'GET')).toBe(true)
  const serialized = JSON.stringify(result)
  for (const secret of ['super-secret-cookie-value', 'private page body', 'refs/heads/main', 'Traceback']) expect(serialized).not.toContain(secret)
  expect(service.requests.every(request => request.method === 'GET')).toBe(true)
  expect(service.requests.length).toBeLessThanOrEqual(12)
})

it('stays quiet for hardened services and SPA fallbacks that answer every path', async () => {
  const hardened = await serve((request, response) => {
    response.setHeader('content-type', 'text/html'); response.setHeader('x-content-type-options', 'nosniff'); response.setHeader('content-security-policy', "default-src 'self'; frame-ancestors 'self'")
    response.setHeader('set-cookie', 'session=value; HttpOnly; SameSite=Lax')
    response.end('<html><title>Single page app</title></html>')
  })
  const result = await scanDynamic(hardened.url, signal())
  expect(result.findings).toEqual([])
  expect(result.engine.status).toBe('completed')
})

it('does not follow cross-origin redirects and never leaves the authorized origin', async () => {
  const service = await serve((_request, response) => { response.statusCode = 302; response.setHeader('location', 'https://elsewhere.invalid/login'); response.end() })
  const visited: string[] = []
  const fetcher: typeof fetch = async (input, init) => { visited.push(String(input)); return fetch(input, init) }
  const result = await scanDynamic(service.url, signal(), fetcher)
  expect(visited.every(url => url.startsWith(service.url))).toBe(true)
  expect(result.engine.status).toBe('partial')
  expect(result.engine.detail).toContain('未跟随')
})

it('marks an unreachable service as failed instead of inventing coverage', async () => {
  const probe = createServer()
  await new Promise<void>(resolve => probe.listen(0, '127.0.0.1', resolve))
  const port = (probe.address() as AddressInfo).port
  await new Promise(resolve => probe.close(resolve))
  const result = await scanDynamic('http://127.0.0.1:' + port + '/', signal())
  expect(result.findings).toEqual([])
  expect(result.engine.status).toBe('failed')
})

it('rejects credentials in the URL and non-HTTP schemes', async () => {
  await expect(scanDynamic('http://user:pass@127.0.0.1/', signal())).rejects.toThrow('dynamic-url')
  await expect(scanDynamic('file:///etc/passwd', signal())).rejects.toThrow('dynamic-url')
})

it('compares runtime findings only with a completed check of the same URL', async () => {
  const service = await serve(insecure)
  const first = await scanDynamic(service.url, signal())
  const empty = { engines: [], findings: [], coverage: { omittedFindings: 0 }, policy: { dynamic: first.target }, baseline: { comparable: true, notObserved: [] } } as unknown as Report
  const baseline = mergeDynamic(empty, first)
  const fixed = { ...first, findings: first.findings.filter(item => item.rule !== 'dynamic.git-exposed') }
  const next = mergeDynamic(empty, fixed, baseline)
  expect(new Set(next.findings.map(item => item.change))).toEqual(new Set(['existing']))
  expect(next.baseline?.notObserved.map(item => item.rule)).toEqual(['dynamic.git-exposed'])
  const otherUrl = mergeDynamic(empty, fixed, { ...baseline, policy: { ...baseline.policy, dynamic: 'http://127.0.0.1:1/' } })
  expect(new Set(otherUrl.findings.map(item => item.change))).toEqual(new Set(['unknown']))
  expect(otherUrl.baseline?.notObserved).toEqual([])
})
