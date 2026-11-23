import { execFileSync } from 'node:child_process'
import { createHash, createPublicKey } from 'node:crypto'
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises'
import { createServer } from 'node:http'
import { createServer as createSecureServer } from 'node:https'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { chromium } from 'playwright'
import { beforeAll, afterAll, expect, it } from 'vitest'
import { AgentBrowser } from '../src/agent-browser.ts'
import { pagePolicyCode } from '../src/browser.ts'
import { createRequestPolicy, navigationUrl, Site } from '../src/site.ts'

let directory, browser, entry, login, site, secureUrl, insecureUrl
let insecureHits = 0, secureHits = 0
beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), 'saas-navigation-'))
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', join(directory, 'key.pem'), '-out', join(directory, 'cert.pem'), '-days', '1', '-subj', '/CN=localhost'], { stdio: 'ignore' })
  login = createSecureServer({ key: await readFile(join(directory, 'key.pem')), cert: await readFile(join(directory, 'cert.pem')) }, (_request, response) => {
    secureHits++; response.writeHead(200, { 'content-type': 'text/html' }); response.end('<h1>Fixture login</h1>')
  })
  login.on('tlsClientError', () => { insecureHits++ })
  await new Promise(resolve => login.listen(0, '127.0.0.1', resolve))
  secureUrl = `https://127.0.0.1:${login.address().port}/sso?return_to=%2Fagents&code=fixture-only`
  insecureUrl = secureUrl.replace('https:', 'http:')
  entry = createServer((request, response) => {
    if (request.url === '/popup') { response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); response.end('<button id="go">去使用</button><script>document.querySelector("#go").onclick=()=>window.open(' + JSON.stringify(insecureUrl) + ')</script>'); return }
    response.writeHead(302, { location: insecureUrl }); response.end()
  })
  await new Promise(resolve => entry.listen(0, '127.0.0.1', resolve))
  const origin = `http://127.0.0.1:${entry.address().port}`
  site = Site.parse({ name: 'Fixture', url: origin + '/agents', allowedOrigins: [origin, new URL(secureUrl).origin], emptyText: 'Empty',
    selectors: Object.fromEntries(['search', 'results', 'card', 'name', 'type', 'version', 'tags', 'description'].map(key => [key, '.' + key])) })
  const fixtureKey = createPublicKey(await readFile(join(directory, 'cert.pem'))).export({ type: 'spki', format: 'der' })
  const fixturePin = createHash('sha256').update(fixtureKey).digest('base64')
  browser = await chromium.launch({ headless: true, args: ['--ignore-certificate-errors-spki-list=' + fixturePin], ...(process.env.DSH_SAAS_BROWSER ? { executablePath: process.env.DSH_SAAS_BROWSER } : process.platform === 'darwin' ? { channel: 'chrome' } : {}) })
}, 30_000)
afterAll(async () => {
  await browser?.close()
  await Promise.all([entry, login].filter(Boolean).map(server => new Promise(resolve => server.close(resolve))))
  if (directory) await rm(directory, { recursive: true, force: true })
})

it('upgrades only to an exact authorized HTTPS origin and preserves redirect parameters', () => {
  const policy = createRequestPolicy({ allowedOrigins: ['https://login.example.test'], blockedHosts: ['blocked.example.test'] })
  expect(policy.permits('http://login.example.test')).toBe(false)
  expect(policy.upgrade('http://login.example.test/sso?a=%2F&b=2')).toBe('https://login.example.test/sso?a=%2F&b=2')
  for (const url of ['http://other.example.test', 'http://sub.login.example.test', 'http://login.example.test:444', 'http://user:password@login.example.test', 'https://login.example.test', 'not a URL']) expect(policy.upgrade(url)).toBeUndefined()
  expect(createRequestPolicy({ allowedOrigins: ['https://blocked.example.test'], blockedHosts: ['example.test'] }).upgrade('http://blocked.example.test')).toBeUndefined()
})

it('allows configured workspace navigation without allowing foreign origins, credentials, or extra query keys', () => {
  const configured = { ...site, navigationPaths: ['/development'], navigationQueryKeys: ['space'] }
  const origin = new URL(site.url).origin
  expect(navigationUrl(configured, origin + '/development?space=demo')).toBe(origin + '/development?space=demo')
  expect(navigationUrl(configured)).toBe(site.url)
  for (const url of [origin + '/api/delete?space=demo', origin + '/development?token=secret', origin + '/development#other-route', 'https://other.example.test/development?space=demo', origin.replace('://', '://user:secret@') + '/development']) expect(() => navigationUrl(configured, url)).toThrow('navigation-not-allowed')
})

it.each(['native', 'legacy'])('%s upgrades a real HTTP SSO redirect before any cleartext traffic reaches the destination', async backend => {
  // Only this test browser trusts the ephemeral fixture's exact public key.
  const context = await browser.newContext({ serviceWorkers: 'block' })
  const page = await context.newPage()
  try {
    const before = secureHits
    if (backend === 'native') {
      const adapter = new AgentBrowser({ read: async () => {}, sessionState: () => ({ page }), closePage: async () => page.close() }, 'fixture', site)
      expect(await adapter.act({ action: 'open' }, new AbortController().signal)).toBeUndefined()
      expect(adapter.blockedOrigin).toBeUndefined()
    } else {
      const path = join(directory, 'legacy-policy.mjs')
      await writeFile(path, pagePolicyCode(site))
      await (await import(pathToFileURL(path).href)).default({ page })
      await page.goto(site.url)
    }
    expect(page.url()).toBe(secureUrl)
    expect(await page.locator('h1').innerText()).toBe('Fixture login')
    expect(secureHits).toBeGreaterThan(before)
    expect(insecureHits).toBe(0)
    expect(page.url()).not.toBe(insecureUrl)
  } finally { await context.close() }
}, 20_000)

it('admits the HTTPS destination of a use popup before upgrading its initial HTTP navigation', async () => {
  const context = await browser.newContext({ serviceWorkers: 'block' }), page = await context.newPage()
  const configured = Site.parse({ ...site, url: new URL('/popup', site.url).href, execution: [{ mode: 'use', origin: new URL(secureUrl).origin, paths: ['/sso'], scope: 'main', input: 'textarea', submit: '.send', output: '.answer', busy: '.busy', error: '.error' }] })
  const adapter = new AgentBrowser({ read: async () => {}, sessionState: () => ({ page }), closePage: async () => {} }, 'popup-upgrade', configured)
  try {
    const observation = await adapter.act({ action: 'open' }, new AbortController().signal)
    const result = await adapter.act({ action: 'click', observation_id: observation.id, ref: observation.controls.find(control => control.label === '去使用').ref }, new AbortController().signal)
    expect(result.url).toBe(secureUrl)
    expect(result.text).toContain('Fixture login')
    expect(insecureHits).toBe(0)
  } finally { await adapter.close(); await context.close() }
})
