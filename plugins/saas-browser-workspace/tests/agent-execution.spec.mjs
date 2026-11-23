import { createServer } from 'node:http'
import { once } from 'node:events'
import { mkdtemp, rm, mkdir, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { chromium } from 'playwright'
import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from 'vitest'
import { AgentBrowser } from '../src/agent-browser.ts'
import { Site } from '../src/site.ts'

let browser, context, page, adapter, server, application, origin, appOrigin, pending, posts, saves, mode, unexpectedPages, directory, journal
const act = args => adapter.act(args, new AbortController().signal)
const args = (observation, purpose) => ({ observation_id: observation.id, ref: observation.controls.find(control => control.purpose === purpose).ref })
function html() {
  return '<!doctype html><meta charset="utf-8"><main><h1>Agent configuration</h1><label>系统提示词<input value="unchanged"></label><button onclick="fetch(\'/save\',{method:\'POST\'})">保存</button><button>去发布</button><button onclick="window.open(\'' + appOrigin + '/use\')">\uE600 去使用</button><section class="chat"><textarea class="message" aria-label="消息"></textarea><div class="send" onclick="send()">发送</div><div class="answers"></div></section></main><script>async function send(){const send=document.querySelector(\'.send\');send.classList.add(\'busy\');try{const r=await fetch(\'/reply\',{method:\'POST\',body:document.querySelector(\'.message\').value});const data=await r.json();const answer=document.createElement(\'div\');answer.className=data.error?\'error\':\'assistant\';answer.textContent=data.error||data.text;document.querySelector(\'.answers\').append(answer)}finally{send.classList.remove(\'busy\')}}</script>'
}
const handler = (req, res) => {
  if (req.url === '/unregistered') unexpectedPages++
  if (req.url === '/reply') { posts++; pending = res; return }
  if (req.url === '/save') { saves++; res.end(); return }
  res.setHeader('content-type', 'text/html; charset=utf-8'); res.end(mode === 'empty' ? '<body><script>const secret="fixture-hidden-script-secret"</script></body>' : html())
}
const release = body => { pending.setHeader('content-type', 'application/json'); pending.end(JSON.stringify(body)); pending = undefined }
const site = () => Site.parse({ name: 'Fixture', url: origin + '/debug', allowedOrigins: [origin, appOrigin], emptyText: 'Empty',
  selectors: Object.fromEntries(['search', 'results', 'card', 'name', 'type', 'version', 'tags', 'description'].map(key => [key, '.' + key])),
  execution: mode === 'readonly' ? [] : [ ['debug', origin, '/debug'], ['use', appOrigin, '/use'] ].map(([mode, origin, path]) => ({ mode, origin, paths: [path], scope: '.chat', input: '.message', submit: '.send', output: '.assistant', busy: '.busy', error: '.error' })) })

beforeAll(async () => {
  server = createServer(handler).listen(0, '127.0.0.1'); await once(server, 'listening'); origin = 'http://127.0.0.1:' + server.address().port
  application = createServer(handler).listen(0, '127.0.0.1'); await once(application, 'listening'); appOrigin = 'http://127.0.0.1:' + application.address().port
  browser = await chromium.launch({ headless: true, ...(process.platform === 'darwin' ? { channel: 'chrome' } : {}) })
}, 20_000)
beforeEach(async () => {
  posts = 0; saves = 0; unexpectedPages = 0; mode = 'enabled'
  directory = await mkdtemp(join(tmpdir(), 'saas-execution-')); journal = join(directory, 'receipts.json')
  context = await browser.newContext({ serviceWorkers: 'block' }); page = await context.newPage()
  adapter = new AgentBrowser({ read: async () => {}, sessionState: () => ({ page }), closePage: async () => {} }, 'execution-test', site(), journal)
})
afterEach(async () => { if (pending) release({ error: 'test-cleanup' }); await adapter.close(); await context.close(); await rm(directory, { recursive: true, force: true }) })
afterAll(async () => { await browser.close(); await Promise.all([new Promise(r => server.close(r)), new Promise(r => application.close(r))]) })

it('protects configuration, observes a delayed real response, and deduplicates submission receipts', async () => {
  let observation = await act({ action: 'open' })
  const save = observation.controls.find(control => control.label === '保存')
  expect(save.canClick).toBe(false)
  await expect(act({ action: 'click', observation_id: observation.id, ref: save.ref })).rejects.toThrow('read-only')
  const config = observation.controls.find(control => control.label === '系统提示词')
  await expect(act({ action: 'fill', observation_id: observation.id, ref: config.ref, text: 'changed' })).rejects.toThrow('read-only')
  observation = await act({ action: 'fill', ...args(observation, 'message'), text: '17+25' })
  await expect(act({ action: 'press', ...args(observation, 'message') })).rejects.toThrow('read-only')
  const submission = { action: 'submit', ...args(observation, 'submit'), request_id: 'debug-1' }
  await act(submission)
  expect(adapter.executions.results[0].status).toBe('running')
  expect(posts).toBe(1)
  await act(submission)
  expect(posts).toBe(1)
  release({ text: '42' })
  await act({ action: 'wait' })
  expect(adapter.executions.results[0]).toMatchObject({ status: 'completed', mode: 'debug', input: '17+25', output: '42' })
  await act(submission)
  expect(posts).toBe(1)
  expect(saves).toBe(0)
  expect(await page.getByLabel('系统提示词').inputValue()).toBe('unchanged')
  await adapter.close(); page = await context.newPage()
  adapter = new AgentBrowser({ read: async () => {}, sessionState: () => ({ page }), closePage: async () => {} }, 'execution-test', site(), journal)
  await act({ action: 'open' }); await act(submission)
  expect(adapter.executions.results[0]).toMatchObject({ status: 'completed', output: '42' })
  expect(posts).toBe(1)
})

it('follows only a configured use popup and keeps its failed result separate from debug output', async () => {
  let observation = await act({ action: 'open' })
  const use = observation.controls.find(control => control.label.includes('去使用'))
  observation = await act({ action: 'click', observation_id: observation.id, ref: use.ref })
  expect(observation.url).toBe(appOrigin + '/use')
  expect(adapter.login).toBe(false)
  observation = await act({ action: 'fill', ...args(observation, 'message'), text: 'test failure' })
  await act({ action: 'submit', ...args(observation, 'submit'), request_id: 'use-1' })
  release({ error: 'Provider unavailable' })
  await act({ action: 'wait' })
  expect(adapter.executions.results[0]).toMatchObject({ mode: 'use', status: 'failed', error: 'Provider unavailable', output: '' })
  expect(posts).toBe(1)
})

it('does not grant message or submit controls when no execution scope is configured', async () => {
  mode = 'readonly'
  await adapter.close()
  page = await context.newPage()
  adapter = new AgentBrowser({ read: async () => {}, sessionState: () => ({ page }), closePage: async () => {} }, 'readonly-test', site())
  const observation = await act({ action: 'open' })
  expect(observation.controls.some(control => control.purpose === 'message' || control.purpose === 'submit')).toBe(false)
  expect(observation.controls.find(control => control.label.includes('去使用')).canClick).toBe(false)
  expect(posts).toBe(0)
})

it('blocks an unregistered popup path before its request reaches the server', async () => {
  const observation = await act({ action: 'open' })
  const use = observation.controls.find(control => control.label.includes('去使用'))
  await page.getByText('去使用', { exact: false }).evaluate((el, url) => { el.onclick = () => window.open(url) }, appOrigin + '/unregistered')
  await expect(act({ action: 'click', observation_id: observation.id, ref: use.ref })).rejects.toThrow('popup-not-allowed')
  expect(unexpectedPages).toBe(0)
})

it('marks interrupted submissions as uncertain after restart and never automatically sends them again', async () => {
  let observation = await act({ action: 'open' })
  observation = await act({ action: 'fill', ...args(observation, 'message'), text: '17+25' })
  await act({ action: 'submit', ...args(observation, 'submit'), request_id: 'interrupted-1' })
  await adapter.close(); release({ text: '42' }); page = await context.newPage()
  adapter = new AgentBrowser({ read: async () => {}, sessionState: () => ({ page }), closePage: async () => {} }, 'execution-test', site(), journal)
  observation = await act({ action: 'open' })
  expect(adapter.executions.results[0].status).toBe('uncertain')
  observation = await act({ action: 'fill', ...args(observation, 'message'), text: '17+25' })
  await expect(act({ action: 'submit', ...args(observation, 'submit'), request_id: 'interrupted-2' })).rejects.toThrow('submission-uncertain')
  expect(posts).toBe(1)
})

it('does not expose inline scripts when the page has no visible text yet', async () => {
  mode = 'empty'
  const observation = await act({ action: 'open' })
  expect(observation.text).toBe('')
  expect(JSON.stringify(observation)).not.toContain('fixture-hidden-script-secret')
})

it('ignores hidden loading indicators and detects a reused error element becoming visible', async () => {
  let observation = await act({ action: 'open' })
  await page.locator('.chat').evaluate(el => el.insertAdjacentHTML('beforeend', '<i class="busy" hidden></i><p class="error" hidden>denied</p>'))
  observation = await act({ action: 'fill', ...args(observation, 'message'), text: '17+25' })
  await act({ action: 'submit', ...args(observation, 'submit'), request_id: 'reused-error' })
  expect(posts).toBe(1)
  await page.locator('.error').evaluate(el => { el.hidden = false })
  await act({ action: 'observe' })
  expect(adapter.executions.results[0]).toMatchObject({ status: 'failed', error: 'denied' })
})

it('marks a disappearing execution area uncertain and prevents a second submission', async () => {
  let observation = await act({ action: 'open' })
  observation = await act({ action: 'fill', ...args(observation, 'message'), text: '17+25' })
  await act({ action: 'submit', ...args(observation, 'submit'), request_id: 'removed-area' })
  await page.locator('.chat').evaluate(el => el.remove())
  await act({ action: 'observe' })
  expect(adapter.executions.results[0]).toMatchObject({ status: 'uncertain', error: 'execution-scope-unavailable' })
  release({ text: '42' })
  observation = await act({ action: 'open' })
  observation = await act({ action: 'fill', ...args(observation, 'message'), text: '17+25' })
  await expect(act({ action: 'submit', ...args(observation, 'submit'), request_id: 'removed-area-again' })).rejects.toThrow('submission-uncertain')
  expect(posts).toBe(1)
})

it('rechecks aria-label and title when a send control changes to a save or publish action', async () => {
  let observation = await act({ action: 'open' })
  observation = await act({ action: 'fill', ...args(observation, 'message'), text: '17+25' })
  for (const [attr, value] of [['aria-label', '保存'], ['title', 'publish']]) {
    await page.locator('.send').evaluate((el, [attr, value]) => el.setAttribute(attr, value), [attr, value])
    await expect(act({ action: 'submit', ...args(observation, 'submit'), request_id: 'changed-send' })).rejects.toThrow('execution-not-authorized')
    await page.locator('.send').evaluate((el, attr) => el.removeAttribute(attr), attr)
  }
  expect(posts).toBe(0); expect(saves).toBe(0)
})


it('does not send when a receipt cannot be saved and removes its temporary journal file', async () => {
  let observation = await act({ action: 'open' })
  await mkdir(journal)
  observation = await act({ action: 'fill', ...args(observation, 'message'), text: '17+25' })
  await expect(act({ action: 'submit', ...args(observation, 'submit'), request_id: 'storage-failed' })).rejects.toThrow('execution-journal-unavailable')
  expect(posts).toBe(0)
  expect(adapter.executions.results[0]).toMatchObject({ status: 'failed', error: 'execution-journal-unavailable' })
  expect(await readdir(directory)).toEqual(['receipts.json'])
})

it('rejects a message field that becomes sensitive before submission', async () => {
  let observation = await act({ action: 'open' })
  observation = await act({ action: 'fill', ...args(observation, 'message'), text: 'private-value' })
  await page.locator('.message').evaluate(el => el.setAttribute('aria-label', 'API token'))
  await expect(act({ action: 'submit', ...args(observation, 'submit'), request_id: 'changed-message' })).rejects.toThrow('execution-control-changed')
  expect(posts).toBe(0); expect(adapter.executions.results).toHaveLength(0)
})
