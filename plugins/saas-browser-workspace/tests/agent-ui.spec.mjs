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
  await page.getByText('查看已读取的页面文本', { exact: true }).click(); await page.getByText('只读配置正文', { exact: true }).waitFor()
  await page.getByRole('button', { name: '查询结果', exact: true }).click(); await page.getByRole('heading', { name: '长名称与复杂输入验证助手', exact: true }).waitFor()
  await page.getByRole('button', { name: '页面内容', exact: true }).click(); await page.getByText('查看已读取的页面文本', { exact: true }).click(); await page.getByText('只读配置正文', { exact: true }).waitFor()
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
  await page.getByRole('button', { name: '查看原页面 ↗', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: '实时页面', exact: true })
  await dialog.getByRole('img').waitFor()
  await dialog.getByRole('button', { name: '接管浏览器', exact: true }).click()
  await dialog.getByRole('button', { name: '交还 Agent 并继续', exact: true }).waitFor()
  await page.evaluate(() => window.reviewUI.disconnectFrame(true))
  await page.getByRole('status').filter({ hasText: '画面暂时中断' }).waitFor()
  expect(await dialog.getByRole('img').getAttribute('aria-disabled')).toBe('true')
  await screenshot('saas-review-disconnected-frame')
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

it('renders a generic page with honest field states', async () => {
  const observation = { id: 'generic', url: 'https://portal.example.test/settings', title: 'Project settings', text: 'Captured text', controls: [], records: [], recordsState: 'unavailable', capturedAt: '2026-11-23T08:01:00Z', truncated: false, document: { blocks: [
    { kind: 'fields', title: 'Settings', fields: [
      { label: 'Instructions', kind: 'multiline', state: 'empty', value: '' },
      { label: 'Custom editor', kind: 'text', state: 'unread', value: '' },
      { label: 'Memory', kind: 'toggle', state: 'value', value: '', checked: 'on' },
      { label: 'Count', kind: 'number', state: 'value', value: '0' },
      { label: '', kind: 'text', state: 'redacted', value: '' },
    ] },
    { kind: 'table', title: 'Requests', columns: ['Name', 'Status'], rows: [['Alpha', 'Open']] },
    { kind: 'list', title: 'Next steps', items: ['Review Alpha', 'Archive Beta'] },
    { kind: 'text', title: 'Summary', text: '<script>window.injected = true</script>' },
  ], gaps: [{ kind: 'collapsed', label: 'Advanced' }, { kind: 'graphic', label: 'Traffic' }], truncated: false } }
  await patch({ view: 'details', details: observation, observation })
  await page.getByRole('heading', { name: 'Project settings' }).waitFor()
  await page.getByText('空值', { exact: true }).waitFor()
  await page.getByText('未能可靠读取', { exact: true }).waitFor()
  await page.getByText('已开启', { exact: true }).waitFor()
  await page.getByRole('cell', { name: 'Alpha', exact: true }).waitFor()
  expect(await page.evaluate(() => window.injected)).toBeUndefined()
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
  await screenshot('saas-generic-structure')
  await page.getByRole('group', { name: '页面展示方式' }).getByRole('button', { name: '原页面画面' }).click()
  await page.locator('.saas-page-preview').getByRole('img').waitFor()
  expect(await page.locator('.saas-page-preview').getByRole('img').getAttribute('aria-disabled')).toBe('true')
  await screenshot('saas-generic-original')
  await patch({ observation: { ...observation, id: 'other', url: 'https://portal.example.test/another' } })
  await page.getByText('浏览器已离开此页或当前不可用。保留的快照不会被其他页面画面替换。').waitFor()
  expect(await page.locator('.saas-page-preview').getByRole('img').count()).toBe(0)
}, 15_000)

it('defaults unsupported HTML to the original image without requiring query records or a presentation call', async () => {
  const observation = { id: 'unsupported', url: 'https://portal.example.test/dashboard', title: 'Custom dashboard', text: '', controls: [], records: [], recordsState: 'unavailable', capturedAt: '2026-11-23T08:01:00Z', truncated: false, document: { blocks: [], gaps: [{ kind: 'unstructured', label: '' }], truncated: false } }
  await patch({ view: 'table', listing: undefined, details: undefined, observation })
  await page.getByRole('heading', { name: 'Custom dashboard' }).waitFor()
  await page.locator('.saas-page-preview').getByRole('img').waitFor()
  expect(await page.locator('nav').getByRole('button', { name: '页面内容' }).getAttribute('aria-pressed')).toBe('true')
  await page.getByRole('button', { name: '结构视图', exact: true }).click()
  await page.getByText('部分内容无法整理成可靠结构，请查看原页面。').first().waitFor()
}, 15_000)
