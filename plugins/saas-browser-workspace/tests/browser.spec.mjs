import { createRequire } from 'node:module'
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createServer } from 'node:http'
import { beforeAll, afterAll, it, expect } from 'vitest'
import { pagePolicyCode, queryCode, loginCode, parseResult, BrowserAdapter } from '../src/browser.ts'
import { Site, isAllowed } from '../src/site.ts'
import { startFixture } from '../scripts/fixture.mjs'

let fixture, browser, context, page, directory
beforeAll(async () => {
  fixture = await startFixture(); directory = await mkdtemp(join(tmpdir(), 'saas-browser-'))
  const require = createRequire(import.meta.resolve('@playwright/mcp/package.json'))
  const { chromium } = require('playwright')
  browser = await chromium.launch({ headless: true, ...(process.env.DSH_SAAS_BROWSER ? { executablePath: process.env.DSH_SAAS_BROWSER } : process.platform === 'darwin' ? { executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' } : {}) })
  context = await browser.newContext({ serviceWorkers: 'block', viewport: { width: 1280, height: 900 } })
  page = await context.newPage()
  const policy = join(directory, 'policy.mjs'); await writeFile(policy, pagePolicyCode(fixture.site, join(directory, 'blocked-navigation.json')))
  await (await import(pathToFileURL(policy).href)).default({ page })
}, 30_000)
afterAll(async () => { await browser?.close(); await fixture?.close(); if (directory) await rm(directory, { recursive: true, force: true }) })
async function query(keyword) {
  const path = join(directory, 'capture.png')
  const run = new Function('return (' + queryCode(fixture.site, keyword, path) + ')')()
  const result = await run(page)
  expect((await readFile(path)).subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a')
  return result
}
it('captures the filtered rendered cards rather than the unchanged global count', async () => {
  const result = await query('初始化')
  expect(result.renderedCount).toBe(3); expect(result.rows).toHaveLength(3)
  expect(result.rows.map(row => row.name)).toContain('发布检查助手')
  expect(await page.locator('main > p b').innerText()).toBe('52')
  expect(await page.locator('.input-before').count()).toBe(0)
}, 30_000)
it('supports zero results and reports bounded coverage for large rendered result sets', async () => {
  expect((await query('missing-record')).rows).toEqual([])
  const result = await query('bulk'); expect(result.renderedCount).toBe(60); expect(result.rows).toHaveLength(50)
}, 30_000)
it('keeps script-shaped input as literal search data', async () => {
  expect((await query('";globalThis.__injected=true;//')).rows).toEqual([])
  expect(await page.evaluate(() => globalThis.__injected)).toBeUndefined()
}, 30_000)
it('blocks a redirect before its disallowed local destination receives a request', async () => {
  let hits = 0
  const forbidden = createServer((_req, res) => { hits++; res.end('outside scope') })
  await new Promise(resolve => forbidden.listen(0, '127.0.0.1', resolve))
  const destination = `http://127.0.0.1:${forbidden.address().port}/blocked?auth_code=fixture-secret`
  // Allow-listed fixture origin redirects to a second origin which is not allow-listed.
  const listener = (request, response) => {
    if (request.url !== '/redirect') return
    response.writeHead(302, { location: destination }); response.end()
  }
  const original = fixture.server.listeners('request')[0]
  fixture.server.removeListener('request', original)
  fixture.server.on('request', (request, response) => request.url === '/redirect' ? listener(request, response) : original(request, response))
  try {
    await expect(page.goto(fixture.origin + '/redirect')).rejects.toThrow(); expect(hits).toBe(0)
    const report = await readFile(join(directory, 'blocked-navigation.json'), 'utf8')
    expect(JSON.parse(report).origin).toBe(new URL(destination).origin)
    expect(report).not.toContain('fixture-secret'); expect(report).not.toContain('/blocked')
  }
  finally { await new Promise(resolve => forbidden.close(resolve)) }
}, 20_000)
it('denies all model-originated raw provider actions and validates MCP results', () => {
  const adapter = new BrowserAdapter({}, Site.parse(fixture.site), directory)
  expect(adapter.guard({ name: 'mcp__saas-playwright__browser_run_code_unsafe', callId: 'untrusted', arguments: { code: 'anything' } })).toContain('Use saas_query_agents')
  expect(adapter.guard({ name: 'saas_query_agents' })).toBeUndefined()
  expect(parseResult({ content: [{ type: 'text', text: '### Result\n{"kind":"login"}\n### Ran Playwright code\n...' }] })).toEqual({ kind: 'login' })
  expect(() => parseResult({ content: [{ type: 'text', text: 'unexpected format' }] })).toThrow('unexpected-browser-result')
  expect(isAllowed({ allowedOrigins: ['https://example.test'], blockedHosts: ['example.test'] }, 'https://example.test/path')).toBe(false)
})
it('resumes the saved query in the same browser after a cross-origin login handoff', async () => {
  const loginFixture = await startFixture({ requireLogin: true })
  const loginContext = await browser.newContext({ serviceWorkers: 'block' })
  try {
    const loginPage = await loginContext.newPage()
    const path = join(directory, 'login-policy.mjs'); await writeFile(path, pagePolicyCode(loginFixture.site))
    await (await import(pathToFileURL(path).href)).default({ page: loginPage })
    const run = new Function('return (' + queryCode(loginFixture.site, '初始化', join(directory, 'after-login.png')) + ')')()
    expect(await run(loginPage)).toEqual({ kind: 'login' })
    const original = loginPage.url()
    const show = new Function('return (' + loginCode(loginFixture.site) + ')')()
    expect(await show(loginPage)).toEqual({ shown: true })
    expect(loginContext.pages()).toHaveLength(1); expect(loginPage.url()).toBe(original)
    await loginPage.getByRole('button', { name: '完成模拟登录' }).click()
    await loginPage.waitForURL(loginFixture.origin + '/agents')
    expect((await run(loginPage)).rows).toHaveLength(3)
    await loginContext.clearCookies()
    expect(await run(loginPage)).toEqual({ kind: 'login' })
  } finally { await loginContext.close(); await loginFixture.close() }
}, 30_000)
it('binds login activation to one host-minted dispatch and revokes the permit afterwards', async () => {
  let dispatched
  const agent = {}, ctx = { tools: { execute: async exec => {
    dispatched = exec
    expect(adapter.guard(exec)).toBeUndefined()
    expect(adapter.guard({ ...exec, agent: {} })).toBeTruthy()
    expect(adapter.guard({ ...exec, arguments: { code: 'arbitrary code' } })).toBeTruthy()
    return { isError: false, value: { content: [{ type: 'text', text: '### Result\n{"shown":true}\n### Ran Playwright code\n...' }] } }
  } } }
  const adapter = new BrowserAdapter(ctx, Site.parse(fixture.site), directory)
  await adapter.showLogin(agent, new AbortController().signal)
  expect(adapter.guard(dispatched)).toBeTruthy()
})
