import { chromium } from 'playwright'
import { beforeAll, afterAll, expect, it } from 'vitest'
import { AgentBrowser } from '../src/agent-browser.ts'
import { Site } from '../src/site.ts'
import { startFixture } from '../scripts/fixture.mjs'

let browser, context, page, fixture, adapter
beforeAll(async () => {
  fixture = await startFixture()
  browser = await chromium.launch({ headless: true, ...(process.platform === 'darwin' ? { channel: 'chrome' } : {}) })
  context = await browser.newContext({ serviceWorkers: 'block' }); page = await context.newPage()
  adapter = new AgentBrowser({ read: async () => {}, sessionState: () => ({ page }), closePage: async () => page.close() }, 'native-fixture', Site.parse(fixture.site))
}, 20_000)
afterAll(async () => { await adapter?.close(); await browser?.close(); await fixture?.close() })
const act = args => adapter.act(args, new AbortController().signal)

it('queries from observed controls, rejects old refs, and reads configuration without exposing a password', async () => {
  await act({ action: 'open' })
  await page.locator('.resource-card-home').first().waitFor()
  let observed = await act({ action: 'observe' })
  const first = observed
  observed = await act({ action: 'fill', observation_id: observed.id, ref: observed.controls.find(control => control.canFill).ref, text: '初始化' })
  await expect(act({ action: 'press', observation_id: first.id, ref: first.controls.find(control => control.canFill).ref })).rejects.toThrow('stale-observation')
  await act({ action: 'press', observation_id: observed.id, ref: observed.controls.find(control => control.canFill).ref })
  await page.locator('.resource-card-home').nth(3).waitFor({ state: 'detached' })
  observed = await act({ action: 'observe' })
  expect(observed.records).toHaveLength(3)
  expect(observed.records[0].actions[0].label).toBe('去配置调试')
  observed = await act({ action: 'click', observation_id: observed.id, ref: observed.records[0].actions[0].ref })
  expect(new URL(observed.url).pathname).toBe('/agents/config')
  expect(observed.text).toContain('配置')
  expect(observed.controls.some(control => control.value === 'fixture-model')).toBe(true)
  expect(JSON.stringify(observed)).not.toContain('fixture-secret')
  expect(observed.controls.find(control => control.label === '自定义 Prompt').value).toBe('自定义 Prompt')
  expect(observed.controls.find(control => control.label === '引用角色').value).toBe('')
  const save = observed.controls.find(control => control.label === '保存')
  expect(save.canClick).toBe(false)
  await expect(act({ action: 'click', observation_id: observed.id, ref: save.ref })).rejects.toThrow('read-only')
}, 20_000)

it('revalidates a search input after it becomes a password or loses its authorized selector', async () => {
  await act({ action: 'open' })
  await page.setContent('<main><input class="div-input" contenteditable="true" aria-label="Search"></main>')
  let observed = await act({ action: 'observe' })
  let search = observed.controls.find(control => control.purpose === 'search')
  await page.locator(fixture.site.selectors.search).evaluate(el => { el.type = 'password' })
  await expect(act({ action: 'fill', observation_id: observed.id, ref: search.ref, text: 'must-not-type' })).rejects.toThrow('page-changed-observe-again')
  await expect(act({ action: 'press', observation_id: observed.id, ref: search.ref })).rejects.toThrow('page-changed-observe-again')
  expect(await page.locator(fixture.site.selectors.search).inputValue()).toBe('')
  await page.locator(fixture.site.selectors.search).evaluate(el => { el.type = 'text' })
  observed = await act({ action: 'observe' }); search = observed.controls.find(control => control.purpose === 'search')
  await page.locator(fixture.site.selectors.search).evaluate(el => { el.outerHTML = '<input aria-label="系统提示词" value="unchanged">' })
  await expect(act({ action: 'fill', observation_id: observed.id, ref: search.ref, text: 'must-not-type' })).rejects.toThrow('page-changed-observe-again')
  expect(await page.getByLabel('系统提示词').inputValue()).toBe('unchanged')
})

it('redacts visible secrets including contenteditable, masked controls and controls beyond the observation limit', async () => {
  await page.setContent('<main><div contenteditable="true" aria-label="API token">editable-secret</div><section class="private"><input aria-label="Account" value="masked-value"><div contenteditable="true">masked-text</div></section>' + '<button>filler</button>'.repeat(180) + '<div contenteditable="true" aria-label="密钥">late-secret</div></main>')
  adapter.site.screenshotMasks.push('.private')
  const observation = await act({ action: 'observe' })
  for (const secret of ['editable-secret', 'masked-value', 'masked-text', 'late-secret']) expect(JSON.stringify(observation)).not.toContain(secret)
  expect(observation.controls[0].sensitive).toBe(true)
  adapter.site.screenshotMasks.pop()
})

it('detects a registered same-origin login path and does not expose the login page', async () => {
  adapter.site.loginPaths.push('/login')
  await page.goto(fixture.origin + '/login')
  expect(adapter.login).toBe(true)
  expect(await act({ action: 'observe' })).toBeUndefined()
  adapter.site.loginPaths.pop()
})
