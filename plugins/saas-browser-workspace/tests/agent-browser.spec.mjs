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

it('projects HTML and ARIA fields without turning placeholders or mode options into content', async () => {
  await page.setContent(`<main><h1>Project settings</h1><section><h2>Assistant settings</h2>
    <label for="prompt">Instructions</label><textarea id="prompt" placeholder="Write instructions here"></textarea>
    <label><input type="radio" name="mode" checked>Custom instructions</label>
    <label><input type="radio" name="mode">Use role</label>
    <span id="memory-name">Remember context</span><div role="switch" aria-labelledby="memory-name" aria-checked="true"></div>
    <div role="switch" aria-label="History" aria-checked="false"></div>
    <div role="checkbox" aria-label="Permissions" aria-checked="mixed"></div>
    <select aria-label="Default model"><option>Model A</option><option selected>Model B</option></select>
    <div role="combobox" aria-label="Backup model" aria-expanded="false">Model C</div>
    <div role="textbox" aria-label="Custom editor"></div>
    <div contenteditable="true" aria-label="Description" data-placeholder="Type here"></div>
    <input aria-label="Count" type="number" value="0">
    </section></main>`)
  const observed = await act({ action: 'observe' })
  const fields = observed.document.blocks.flatMap(block => block.kind === 'fields' ? block.fields : [])
  expect(fields.find(f => f.label === 'Instructions')).toMatchObject({ state: 'empty', value: '' })
  expect(fields.find(f => f.label === 'Custom instructions')).toMatchObject({ kind: 'choice', state: 'value', checked: 'on', value: '' })
  expect(fields.find(f => f.label === 'Use role')).toMatchObject({ checked: 'off' })
  expect(fields.find(f => f.label === 'Remember context')).toMatchObject({ checked: 'on' })
  expect(fields.find(f => f.label === 'History')).toMatchObject({ checked: 'off' })
  expect(fields.find(f => f.label === 'Permissions')).toMatchObject({ checked: 'mixed' })
  expect(fields.find(f => f.label === 'Default model').value).toBe('Model B')
  expect(fields.find(f => f.label === 'Backup model').value).toBe('Model C')
  expect(fields.find(f => f.label === 'Custom editor').state).toBe('unread')
  expect(fields.find(f => f.label === 'Description').state).toBe('empty')
  expect(fields.find(f => f.label === 'Count')).toMatchObject({ value: '0', state: 'value' })
  expect(JSON.stringify(observed.document)).not.toContain('Write instructions here')
  expect(observed.document.blocks.find(block => block.kind === 'fields').title).toBe('Assistant settings')
})

it('reads generic content without site query selectors and reports complex regions honestly', async () => {
  await page.setContent(`<main><h1>Operations</h1><section><h2>Overview</h2><p>Two items need review.</p>
    <dl><dt>Active</dt><dd>12</dd></dl>
    <table><caption>Requests</caption><thead><tr><th>Name</th><th>Status</th></tr></thead><tbody><tr><td>Alpha</td><td>Open</td></tr><tr><td>Beta</td><td>Closed</td></tr></tbody></table>
    <ul aria-label="Next steps"><li>Review Alpha</li><li>Archive Beta</li></ul>
    <details><summary>Advanced rules</summary><p>unread-content</p></details>
    <canvas aria-label="Traffic" width="500" height="160"></canvas>
    <iframe title="Embedded report" srcdoc="<p>frame-secret</p>"></iframe>
    <div class="monaco-editor" style="height:100px"><textarea aria-label="Rendered lines">partial-code</textarea></div>
    </section></main>`)
  const observed = await act({ action: 'observe' }), doc = observed.document
  expect(doc.blocks.find(block => block.kind === 'table')).toMatchObject({ title: 'Requests', columns: ['Name', 'Status'], rows: [['Alpha', 'Open'], ['Beta', 'Closed']] })
  expect(doc.blocks.find(block => block.kind === 'list')).toMatchObject({ items: ['Review Alpha', 'Archive Beta'] })
  expect(doc.blocks.some(block => block.kind === 'text' && block.text === 'Two items need review.')).toBe(true)
  expect(doc.gaps.map(gap => gap.kind)).toEqual(expect.arrayContaining(['collapsed', 'graphic', 'embedded', 'editor']))
  expect(JSON.stringify(doc)).not.toMatch(/unread-content|frame-secret|partial-code/)
  const generic = Site.parse({ name: 'Generic portal', url: fixture.origin, allowedOrigins: [fixture.origin] })
  expect(generic.selectors.search).toBe(':not(*)')
  expect(generic.execution).toEqual([])
})

it('keeps secrets, masks and hidden content out of every projection and reports unread custom pages', async () => {
  await page.setContent(`<main><h2>Account</h2><label for="s">API key</label><input id="s" value="secret-alpha">
    <div role="textbox" aria-label="Password">secret-beta</div><dl><dt>Access token</dt><dd>secret-gamma</dd></dl>
    <section aria-hidden="true"><label>Hidden<input value="secret-hidden"></label><p>hidden-copy</p></section>
    <div style="opacity:0"><p>invisible-copy</p></div><p>Public information</p></main>`)
  const observed = await act({ action: 'observe' })
  expect(JSON.stringify(observed)).not.toMatch(/secret-alpha|secret-beta|secret-gamma|secret-hidden|hidden-copy|invisible-copy/)
  expect(observed.document.blocks.flatMap(b => b.kind === 'fields' ? b.fields : []).filter(f => f.state === 'redacted')).toHaveLength(3)
  await page.setContent('<main><div>Unstructured widget</div><custom-widget></custom-widget></main>')
  await page.locator('custom-widget').evaluate(el => { el.attachShadow({ mode: 'open' }).innerHTML = '<p>Inside shadow</p>'; el.style.display = 'block'; el.style.height = '40px' })
  const fallback = (await act({ action: 'observe' })).document
  expect(fallback.blocks).toEqual([])
  expect(fallback.gaps.map(g => g.kind)).toEqual(expect.arrayContaining(['unstructured', 'embedded']))
})

it('bounds large structures and marks clipped tables instead of implying complete coverage', async () => {
  await page.setContent('<main><table aria-rowcount="300"><tr><th>Name</th></tr>' + Array.from({ length: 50 }, (_, i) => '<tr><td>record-' + i + '</td></tr>').join('') + '</table><textarea aria-label="Instructions">' + 'x'.repeat(10000) + '</textarea></main>')
  const doc = (await act({ action: 'observe' })).document
  expect(doc.blocks.find(b => b.kind === 'table').rows).toHaveLength(20)
  expect(doc.blocks.flatMap(b => b.kind === 'fields' ? b.fields : [])[0].value).toHaveLength(3000)
  expect(doc.truncated).toBe(true)
  expect(doc.gaps.some(g => g.kind === 'limit')).toBe(true)
})

it('opens a native disclosure directly and reads its resource and retrieval settings', async () => {
  await act({ action: 'open' })
  await page.setContent(`<main><details><summary>知识库（1）</summary><p>Fixture handbook</p>
    <label>检索数量<input type="number" value="5"></label></details></main>`)
  const before = await act({ action: 'observe' })
  expect(before.text).not.toContain('Fixture handbook')
  const toggle = before.controls.find(control => control.purpose === 'disclosure')
  expect(toggle).toMatchObject({ label: '知识库（1）', canClick: true })
  const after = await act({ action: 'click', observation_id: before.id, ref: toggle.ref })
  expect(after.text).toContain('Fixture handbook')
  expect(after.document.blocks.flatMap(block => block.fields ?? [])).toContainEqual(
    expect.objectContaining({ label: '检索数量', value: '5' }),
  )
  expect(adapter.approvals.review).toBeUndefined()
})

it('reviews custom clicks and edits with a frozen image, rejects changed parameters, and consumes approval once', async () => {
  const signal = new AbortController().signal
  await act({ action: 'open' })
  adapter.site.approvalPaths.push('/agents')
  try {
    await page.setContent(`<main><label>检索数量<input id="limit" type="number" value="5"></label>
      <label>API Key<input type="password" value="fixture-private"></label>
      <label>检索模式<select><option value="a">向量</option><option value="b">混合</option></select></label>
      <button type="button" aria-expanded="false" onclick="this.setAttribute('aria-expanded','true');document.querySelector('section').hidden=false">知识库（1）</button>
      <section hidden><p>Fixture handbook</p></section>
      <button onclick="window.saves=(window.saves||0)+1">保存</button></main>`)
    const request = async (action, label, text) => {
      const observation = await act({ action: 'observe' })
      const control = observation.controls.find(control => control.label === label)
      expect(control.approval).toContain(action)
      await act({ action, observation_id: observation.id, ref: control.ref, ...(text === undefined ? {} : { text }) })
      return adapter.approvals.review
    }
    let review = await request('click', '知识库（1）')
    expect(await page.getByText('Fixture handbook').isVisible()).toBe(false)
    expect(await adapter.approve(review.id, signal)).toMatchObject({ text: expect.stringContaining('Fixture handbook') })

    review = await request('fill', '检索数量', '8')
    expect(review).toMatchObject({ before: '5', after: '8', label: '检索数量' })
    expect(JSON.stringify(review)).not.toContain('fixture-private')
    expect(adapter.approvals.frame(review.id).subarray(0, 2).toString('hex')).toBe('ffd8')
    expect(() => adapter.approvals.frame('other')).toThrow('stale-approval')
    expect(await page.locator('#limit').inputValue()).toBe('5')
    await expect(act({ action: 'observe' })).rejects.toThrow('approval-pending')
    await adapter.approve(review.id, signal)
    expect(await page.locator('#limit').inputValue()).toBe('8')
    await expect(adapter.approve(review.id, signal)).rejects.toThrow('stale-approval')

    review = await request('select', '检索模式', 'b')
    expect(review).toMatchObject({ before: '向量', after: '混合' })
    await adapter.approve(review.id, signal)
    expect(await page.locator('select').inputValue()).toBe('b')

    review = await request('click', '保存')
    await page.locator('#limit').evaluate(el => { el.value = '9' })
    await expect(adapter.approve(review.id, signal)).rejects.toThrow('stale-approval')
    expect(await page.evaluate(() => window.saves ?? 0)).toBe(0)

    review = await request('click', '保存')
    await adapter.approvals.clear(review.id)
    await expect(adapter.approve(review.id, signal)).rejects.toThrow('stale-approval')
    expect(await page.evaluate(() => window.saves ?? 0)).toBe(0)

    review = await request('click', '保存')
    await page.getByRole('button', { name: '保存' }).evaluate(el => el.replaceWith(el.cloneNode(true)))
    await expect(adapter.approve(review.id, signal)).rejects.toThrow('stale-approval')
    expect(await page.evaluate(() => window.saves ?? 0)).toBe(0)

    review = await request('click', '保存')
    await adapter.approve(review.id, signal)
    expect(await page.evaluate(() => window.saves)).toBe(1)
    await expect(adapter.approve(review.id, signal)).rejects.toThrow('stale-approval')
  } finally { await adapter.approvals.clear(); adapter.site.approvalPaths.pop() }
}, 20_000)
