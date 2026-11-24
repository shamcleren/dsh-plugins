import { createServer } from 'node:http'
import { once } from 'node:events'
import { mkdtemp, readFile, rm, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { build } from 'tsdown'
import { chromium } from 'playwright'
import { beforeAll, beforeEach, afterAll, afterEach, expect, it } from 'vitest'
import config from '../tsdown.client.config.ts'
let directory, server, browser, page, origin
beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), 'saas-ui-'))
  await build({ ...config, plugins: [...config.plugins, {
    name: 'unused-host-code-renderers',
    // Form/stat UI never uses these host-only code renderers. Fail if that changes.
    resolveId(id) { if (id === '@deepseek-ai/dsh-client-ui-primitives') return '\0host-code-renderers.js' },
    load(id) { if (id === '\0host-code-renderers.js') return 'const unsupported=()=>{throw new Error("Host code rendering requires the official-profile smoke test")};export {unsupported as CodeBlock,unsupported as DiffBlock,unsupported as JsonTree,unsupported as writeClipboard};' },
  }], config: false, entry: { ui: 'tests/fixtures/workspace-ui.tsx' }, outDir: directory, format: 'esm', deps: { alwaysBundle: [/./] }, outputOptions: { codeSplitting: false, entryFileNames: 'ui.js' }, report: false })
  const bytes = await readFile(join(directory, 'ui.js'))
  server = createServer((req, res) => {
    res.setHeader('content-type', req.url === '/ui.js' ? 'text/javascript' : 'text/html; charset=utf-8')
    res.end(req.url === '/ui.js' ? bytes : '<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width"><style>body{margin:0;background:#f5f7fb;color:#243047}#root{max-width:440px;min-height:100vh;margin:auto;background:#fff;border:1px solid #dce3ee}</style><div id="root"></div><script type="module" src="/ui.js"></script>')
  }).listen(0, '127.0.0.1'); await once(server, 'listening'); origin = 'http://127.0.0.1:' + server.address().port
  browser = await chromium.launch({ headless: true, ...(process.platform === 'darwin' ? { channel: 'chrome' } : {}) })
}, 45_000)
beforeEach(async () => { page = await browser.newPage({ viewport: { width: 400, height: 1000 } }); const errors = []; page.on('pageerror', error => errors.push(error.message)); await page.goto(origin); await page.waitForFunction(() => !!window.reviewUI, undefined, { timeout: 5000 }).catch(() => { throw new Error('UI did not mount: ' + errors.join('; ')) }); await page.getByRole('heading', { name: '服务市场 · 交互验收' }).waitFor() })
afterEach(async () => { await page.close() })
afterAll(async () => { await browser?.close(); if (server) { const closed = once(server, 'close'); server.close(); server.closeAllConnections(); await closed } if (directory) await rm(directory, { recursive: true, force: true }) })
const patch = value => page.evaluate(next => window.reviewUI.patch(next), value)
const screenshot = async name => { if (process.env.DSH_SAAS_UI_ARTIFACT_DIR) { await mkdir(process.env.DSH_SAAS_UI_ARTIFACT_DIR, { recursive: true }); await page.screenshot({ path: join(process.env.DSH_SAAS_UI_ARTIFACT_DIR, name + '.png'), fullPage: true }) } }

it('shows selectable results directly in a narrow panel and renders actual GenUI form validation and multiline input', async () => {
  await page.getByRole('heading', { name: '初始化助手', exact: true }).waitFor()
  expect(await page.getByRole('button', { name: '调试 →', exact: true }).isDisabled()).toBe(true)
  await patch({ phase: 'awaiting_input', question: { id: '00000000-0000-4000-8000-000000000003', title: '补充本次任务', fields: [{ name: 'message', label: '需要发送的内容', type: 'textarea', required: true }] } })
  await page.getByRole('heading', { name: '补充本次任务', exact: true }).waitFor()
  expect(await page.getByRole('button', { name: '提交并继续', exact: true }).isDisabled()).toBe(true)
  expect(await page.evaluate(() => window.reviewUI.calls.filter(call => call.method === 'answer').length)).toBe(0)
  await page.locator('textarea').fill('第一行任务\n第二行补充说明')
  await screenshot('saas-review-form')
  await page.getByRole('button', { name: '提交并继续', exact: true }).evaluate(button => { button.click(); button.click() })
  await page.getByRole('status').filter({ hasText: '已提交' }).waitFor()
  expect(await page.evaluate(() => window.reviewUI.calls.filter(call => call.method === 'answer'))).toMatchObject([{ payload: { answers: { message: '第一行任务\n第二行补充说明' } } }])
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
  await patch({ phase: 'awaiting_input', question: { id: '00000000-0000-4000-8000-000000000004', title: '可选说明', fields: [{ name: 'note', label: '备注', required: false, type: 'text' }] } })
  await page.getByRole('button', { name: '跳过可选参数', exact: true }).click()
  await page.getByRole('status').filter({ hasText: '已提交' }).waitFor()
  expect(await page.evaluate(() => window.reviewUI.calls.filter(call => call.method === 'answer').at(-1).payload.answers)).toEqual({})
}, 15_000)

it('switches back to retained configuration and results, and signals stale state after disconnect', async () => {
  await patch({ view: 'details', selected: { id: 'r0', name: '初始化助手', version: 'v1.2', type: '单智能体', description: '', tags: [], actions: [] }, details: { id: 'details', url: 'https://portal.example.test/config', title: '配置', text: '只读配置正文', controls: [], records: [], recordsState: 'unavailable', capturedAt: '2026-11-23T08:01:00Z', truncated: false }, executions: [{ id: 'fixture', mode: 'debug', status: 'completed', input: '17+25（合成结果，用于UI验收）', output: '42', url: 'https://portal.example.test/config', startedAt: '2026-11-23T08:02:00Z', updatedAt: '2026-11-23T08:02:01Z' }] })
  await page.locator('.saas-agent .saas-stream[data-stale=false] canvas').waitFor()
  await page.getByRole('button', { name: '查询结果', exact: true }).click(); await page.getByRole('heading', { name: '长名称与复杂输入验证助手', exact: true }).waitFor()
  await page.getByRole('button', { name: '原网页', exact: true }).click(); await page.locator('.saas-agent .saas-stream[data-stale=false] canvas').waitFor()
  await page.getByRole('button', { name: '查询结果', exact: true }).click()
  await page.getByText('当前已读取: 2', { exact: true }).waitFor()
  await page.getByText('汇总', { exact: true }).click()
  await page.getByText('工作流 · 1', { exact: true }).waitFor()
  expect(await page.getByRole('heading', { name: '初始化助手', exact: true }).isVisible()).toBe(true)
  await page.getByRole('button', { name: '执行结果', exact: true }).click(); await page.getByText('42', { exact: true }).waitFor()
  await screenshot('saas-review-results')
  await page.evaluate(() => window.reviewUI.disconnect(true))
  await page.getByRole('alert').filter({ hasText: '连接已中断' }).waitFor()
  expect(await page.getByText('42', { exact: true }).isVisible()).toBe(true)
  expect(await page.getByRole('button', { name: '调试 →', exact: true }).isDisabled()).toBe(true)
  await page.evaluate(() => window.reviewUI.disconnect(false)); await page.getByRole('button', { name: '重新连接', exact: true }).click()
  await page.getByRole('alert').filter({ hasText: '连接已中断' }).waitFor({ state: 'detached' })
}, 15_000)

it('opens the original-page dialog, suspends stale frames, and offers keyboard escape', async () => {
  await page.getByRole('button', { name: '放大 ↗', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: '实时页面', exact: true })
  await dialog.getByRole('img').waitFor()
  await dialog.getByRole('button', { name: '接管浏览器', exact: true }).click()
  await dialog.getByRole('button', { name: '交还 Agent 并继续', exact: true }).waitFor()
  await page.evaluate(() => window.reviewUI.disconnectFrame(true))
  await dialog.getByRole('status').filter({ hasText: '画面暂时中断' }).waitFor()
  expect(await dialog.getByRole('img').getAttribute('aria-disabled')).toBe('true')
  await screenshot('saas-review-disconnected-frame')
  await page.evaluate(() => window.reviewUI.disconnectFrame(false))
  await dialog.locator('canvas[aria-disabled=false]').waitFor()
  await page.keyboard.press('Escape'); expect(await dialog.isVisible()).toBe(false)
}, 15_000)

it('shows one query view for existing presentation values while preserving record selection', async () => {
  for (const view of ['table', 'list', 'summary']) {
    const siteName = '查询测试 · ' + view
    await patch({ view, siteName })
    await page.getByRole('heading', { name: siteName, exact: true }).waitFor()
    expect(await page.getByRole('button', { name: '查询结果', exact: true }).getAttribute('aria-pressed')).toBe('true')
    expect(await page.getByRole('button', { name: /^(表格|列表)$/ }).count()).toBe(0)
    expect(await page.getByRole('heading', { name: '初始化助手', exact: true }).count()).toBe(1)
  }
  await page.getByRole('button', { name: '查看配置: 初始化助手', exact: true }).click()
  await page.getByRole('status').filter({ hasText: '已提交' }).waitFor()
  expect(await page.evaluate(() => window.reviewUI.calls.filter(call => call.method === 'select'))).toMatchObject([{
    payload: { observationId: '00000000-0000-4000-8000-000000000002', recordId: 'r0' },
  }])
}, 15_000)

it('uses the live page as the original view without a DOM reconstruction', async () => {
  await patch({ view: 'details', listing: undefined, details: undefined })
  const frame = page.locator('.saas-agent .saas-stream[data-stale=false] canvas')
  await frame.waitFor()
  expect(await page.getByRole('button', { name: '原网页', exact: true }).getAttribute('aria-pressed')).toBe('true')
  expect(await page.getByRole('button', { name: '结构视图', exact: true }).count()).toBe(0)
  expect(await frame.getAttribute('aria-disabled')).toBe('true')
  await page.getByRole('button', { name: '接管浏览器', exact: true }).click()
  await frame.and(page.locator('[width="480"][aria-disabled=false]')).waitFor()
  const box = await frame.boundingBox()
  await page.mouse.move(box.x + 50, box.y + 80)
  await page.mouse.wheel(0, 90)
  await page.waitForFunction(() => window.reviewUI.calls.some(call => call.method === 'input' && call.payload.input.kind === 'scroll'))
  const scroll = await page.evaluate(() => window.reviewUI.calls.find(call => call.method === 'input').payload)
  expect(scroll).toMatchObject({ epoch: 2, input: { kind: 'scroll', x: expect.any(Number), y: expect.any(Number) } })
  expect(scroll.input.delta).toBeGreaterThanOrEqual(90)
  await screenshot('saas-docked-original')
  await page.getByRole('button', { name: '交还 Agent 并继续', exact: true }).click()
  await frame.and(page.locator('[aria-disabled=true]')).waitFor()
}, 15_000)

it('keeps the login popup and forwards composed text from its keyboard field', async () => {
  await patch({ phase: 'human', humanReason: 'login' })
  const modal = page.getByRole('dialog', { name: '实时页面' })
  const frame = modal.locator('canvas[aria-disabled=false]')
  await frame.click()
  const keyboard = modal.getByRole('textbox', { name: '输入到登录网页' })
  await keyboard.fill('用于测试的中文输入')
  await page.waitForFunction(() => window.reviewUI.calls.some(call => call.method === 'input' && call.payload.input.kind === 'text'))
  expect(await page.evaluate(() => window.reviewUI.calls.find(call => call.payload.input?.kind === 'text').payload.input.text)).toBe('用于测试的中文输入')
}, 15_000)

it('shows the action, proposed parameters and static screenshot before the owner can approve', async () => {
  const id = '00000000-0000-4000-8000-000000000009'
  await patch({ phase: 'awaiting_approval', approvalEnabled: true, review: {
    id, action: 'fill', label: '检索数量', before: '5', after: '8', expiresAt: '2099-01-01T00:00:00.000Z',
    url: 'https://portal.example.test/config', pageTitle: '智能体配置', fields: [], fieldsLimited: false,
    target: { left: 9, top: 12, width: 30, height: 8 },
  } })
  const card = page.getByRole('region', { name: '确认网页操作' })
  await card.getByText('填写 · 检索数量').waitFor()
  await card.getByRole('img', { name: '操作前的原页面截图' }).waitFor()
  await card.getByText('8', { exact: true }).waitFor()
  await screenshot('saas-approval-card')
  await card.getByRole('button', { name: '放大查看原页面 ↗' }).click()
  const zoom = page.getByRole('dialog', { name: '操作前的原页面截图' })
  await zoom.waitFor()
  await zoom.getByRole('button', { name: '收起页面' }).click()
  await card.getByRole('button', { name: '确认并执行' }).click()
  await card.waitFor({ state: 'detached' })
  expect(await page.evaluate(() => window.reviewUI.calls.filter(call => call.method === 'approve'))).toMatchObject([
    { payload: { approvalId: id } },
  ])
}, 15_000)
