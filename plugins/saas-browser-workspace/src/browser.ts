import { randomUUID } from 'node:crypto'
import { readFile, stat, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'
import type { Context } from '@deepseek-ai/cordis'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import type { ToolExecution, ToolRunContext } from '@deepseek-ai/dsh-tools'
import { PREFIX, Observation, Row, WorkspaceError } from './contract.js'
import { createRequestPolicy, isAllowed, type Site } from './site.js'

const PageResult = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('login') }).strict(),
  z.object({ kind: z.literal('result'), url: z.string(), title: z.string(), rows: z.array(Row).max(50), renderedCount: z.number().int().nonnegative() }).strict(),
])

/** Only fixed host recipes may use this provider, including an owner-requested login handoff. */
export class BrowserAdapter {
  private permits = new Map<string, { parent: ToolExecution['parent']; agent: ToolExecution['agent']; arguments: string }>()
  constructor(private readonly ctx: Context, private readonly site: Site, private readonly outputDir: string, private readonly blockedPath?: string) {}
  guard = (exec: Readonly<ToolExecution>): string | undefined => {
    if (!exec.name.startsWith(PREFIX)) return
    const permit = this.permits.get(exec.callId)
    if (exec.name !== `${PREFIX}browser_run_code_unsafe` || !permit || permit.parent !== exec.parent || permit.agent !== exec.agent
      || permit.arguments !== JSON.stringify(exec.arguments)) return 'Use saas_query_agents: raw browser actions are outside this demo task.'
  }
  async showLogin(agent: NonNullable<ToolExecution['agent']>, signal: AbortSignal): Promise<void> {
    const args = { code: loginCode(this.site) }, callId = ToolCallId(randomUUID())
    this.permits.set(callId, { parent: undefined, agent, arguments: JSON.stringify(args) })
    try {
      const result = await this.ctx.tools.execute({ callId, name: `${PREFIX}browser_run_code_unsafe`, arguments: args, agent, signal })
      if (result.isError) throw new WorkspaceError('login-window-unavailable')
      z.object({ shown: z.literal(true) }).strict().parse(resultJson(result.value))
    } finally { this.permits.delete(callId) }
  }
  async query(keyword: string, exec: ToolRunContext): Promise<Observation | 'awaiting_login'> {
    if (this.blockedPath) await rm(this.blockedPath, { force: true })
    const evidenceId = randomUUID()
    const path = join(this.outputDir, `${evidenceId}.png`)
    const args = { code: queryCode(this.site, keyword, path) }
    const callId = ToolCallId(randomUUID())
    this.permits.set(callId, { parent: exec.token, agent: exec.agent, arguments: JSON.stringify(args) })
    try {
      const result = await this.ctx.tools.execute({ callId, rootCallId: exec.rootCallId, parent: exec.token,
        name: `${PREFIX}browser_run_code_unsafe`, arguments: args, ...(exec.agent ? { agent: exec.agent } : {}), signal: exec.signal })
      for (const context of result.additionalContexts ?? []) exec.deferContext(context)
      if (result.isError) throw new WorkspaceError(`browser-${result.error.info?.code ?? 'call-failed'}`.slice(0, 100))
      const value = parseResult(result.value)
      if (value.kind === 'login') return 'awaiting_login'
      if (!isAllowed(this.site, value.url) || new URL(value.url).origin !== new URL(this.site.url).origin) throw new WorkspaceError('unexpected-page')
      const image = await stat(path)
      if (!image.isFile() || image.size < 8 || image.size > 8 * 1024 * 1024) throw new WorkspaceError('invalid-screenshot')
      const signature = (await readFile(path)).subarray(0, 8).toString('hex')
      if (signature !== '89504e470d0a1a0a') throw new WorkspaceError('invalid-screenshot')
      const counts: Record<string, number> = Object.create(null) as Record<string, number>
      for (const row of value.rows) counts[row.type || '—'] = (counts[row.type || '—'] ?? 0) + 1
      const url = new URL(value.url); url.search = ''; url.hash = ''
      return Observation.parse({ id: randomUUID(), capturedAt: new Date().toISOString(), url: url.href, title: value.title,
        rows: value.rows, renderedCount: value.renderedCount, truncated: value.renderedCount > value.rows.length,
        coverage: 'rendered-results', evidenceId, counts })
    } finally { this.permits.delete(callId) }
  }
}

export function parseResult(value: unknown): z.infer<typeof PageResult> {
  return PageResult.parse(resultJson(value))
}
function resultJson(value: unknown): unknown {
  const envelope = z.object({ content: z.array(z.object({ type: z.string(), text: z.string().optional() }).passthrough()) }).passthrough().parse(value)
  const text = envelope.content.filter(block => block.type === 'text').map(block => block.text ?? '').join('\n')
  // Playwright MCP has a documented human-readable result section, followed by its code section.
  const result = /### Result\s*\n([\s\S]*?)(?=\n### |$)/u.exec(text)?.[1]?.trim()
  if (!result || result.length > 200_000) throw new WorkspaceError('unexpected-browser-result')
  return JSON.parse(result)
}

/** Activate the existing task tab; opening a new tab would not transfer its login state. */
export function loginCode(site: Site): string {
  return `async (page) => {
    const origins = ${JSON.stringify(site.allowedOrigins)};
    if (!origins.some(origin => page.url() === origin || page.url().startsWith(origin + '/'))) throw new Error('login-window-unavailable');
    await page.bringToFront();
    return { shown: true };
  }`
}

/** Trusted, fixed recipe. User values are JSON literals, never source, selectors or file paths. */
export function queryCode(site: Site, keyword: string, screenshotPath: string): string {
  const config = { url: site.url, selectors: site.selectors, emptyText: site.emptyText, masks: site.screenshotMasks }
  return `async (page) => {
    const config = ${JSON.stringify(config)};
    const keyword = ${JSON.stringify(keyword)};
    const origin = ${JSON.stringify(new URL(site.url).origin)};
    const sameOrigin = value => value === origin || value.startsWith(origin + '/');
    await page.goto(config.url, { waitUntil: 'domcontentloaded', timeout: 20000 });
    if (!sameOrigin(page.url())) return { kind: 'login' };
    const search = page.locator(config.selectors.search);
    try { await search.waitFor({ state: 'visible', timeout: 10000 }); }
    catch { if (!sameOrigin(page.url())) return { kind: 'login' }; throw new Error('search-unavailable'); }
    if (await search.count() !== 1) throw new Error('ambiguous-search');
    await page.waitForLoadState('networkidle', { timeout: 15000 });
    if (keyword) {
      await search.fill(keyword);
      const responsePromise = page.waitForResponse(response =>
        ['fetch', 'xhr'].includes(response.request().resourceType()) && sameOrigin(response.url()),
        { timeout: 15000 });
      const [response] = await Promise.all([responsePromise, page.locator(config.selectors.search).press('Enter')]);
      if (!response.ok()) throw new Error('query-response-failed');
      await response.finished();
      await page.waitForLoadState('networkidle', { timeout: 15000 });
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    }
    if (!sameOrigin(page.url())) return { kind: 'login' };
    await page.locator(config.selectors.results).waitFor({ state: 'visible', timeout: 10000 });
    const collect = async () => page.evaluate(({ selectors, emptyText }) => {
      const root = document.querySelector(selectors.results);
      if (!root) throw new Error('results-unavailable');
      const cards = Array.from(root.querySelectorAll(selectors.card));
      if (!cards.length && !(root.textContent || '').includes(emptyText)) throw new Error('results-not-ready');
      const text = (node, selector, limit) => (node.querySelector(selector)?.innerText || '').trim().slice(0, limit);
      const rows = cards.slice(0, 50).map((card, index) => ({
        key: String(index), name: text(card, selectors.name, 500), type: text(card, selectors.type, 200),
        version: text(card, selectors.version, 200), description: text(card, selectors.description, 2000),
        tags: Array.from(card.querySelectorAll(selectors.tags)).filter(tag => tag.getClientRects().length).slice(0, 20).map(tag => (tag.innerText || '').trim().slice(0, 200))
      }));
      if (rows.some(row => !row.name)) throw new Error('record-shape-changed');
      return { kind: 'result', url: location.href, title: document.title.slice(0, 300), rows, renderedCount: cards.length };
    }, config);
    const before = await collect();
    await page.screenshot({ path: ${JSON.stringify(screenshotPath)}, type: 'png', fullPage: false,
      mask: ['input[type="password"]', ...config.masks].map(selector => page.locator(selector)) });
    const after = await collect();
    if (JSON.stringify(before) !== JSON.stringify(after)) throw new Error('page-changed-during-capture');
    return after;
  }`
}

/** Owned page setup also intercepts Chromium redirect requests; Playwright's origin option alone does not. */
export function pagePolicyCode(site: Site, blockedPath?: string): string {
  return `import { writeFile, rename } from 'node:fs/promises';
  let recording = Promise.resolve();
  const report = value => {
    const path = ${JSON.stringify(blockedPath ?? null)};
    if (!path) return Promise.resolve();
    const origin = new URL(value).origin;
    if (origin.length > 512) return Promise.resolve();
    const data = JSON.stringify({ origin, at: new Date().toISOString() });
    recording = recording.then(async () => {
      await writeFile(path + '.next', data, { mode: 0o600 });
      await rename(path + '.next', path);
    }).catch(() => {});
    return recording;
  };
  export default async ({ page }) => {
    const policy = (${createRequestPolicy.toString()})(${JSON.stringify({ allowedOrigins: site.allowedOrigins, blockedHosts: site.blockedHosts })});
    const permits = policy.permits;
    const context = page.context();
    await context.route('**/*', async route => {
      const request = route.request();
      const secure = request.isNavigationRequest() && request.method() === 'GET' ? policy.upgrade(request.url()) : undefined;
      if (secure) return route.fulfill({ status: 307, headers: { location: secure, 'cache-control': 'no-store' }, body: '' });
      if (permits(route.request().url())) return route.continue();
      if (route.request().isNavigationRequest()) await report(route.request().url());
      return route.abort('blockedbyclient');
    });
    await context.routeWebSocket('**/*', socket => socket.close());
    const cdp = await context.newCDPSession(page);
    cdp.on('Fetch.requestPaused', event => { void (async () => {
      const secure = event.resourceType === 'Document' && event.request.method === 'GET' ? policy.upgrade(event.request.url) : undefined;
      if (secure) return cdp.send('Fetch.fulfillRequest', { requestId: event.requestId, responseCode: 307,
        responseHeaders: [{ name: 'Location', value: secure }, { name: 'Cache-Control', value: 'no-store' }], body: '' });
      const method = permits(event.request.url) ? 'Fetch.continueRequest' : 'Fetch.failRequest';
      if (method === 'Fetch.failRequest' && event.resourceType === 'Document') await report(event.request.url);
      const args = { requestId: event.requestId, ...(method === 'Fetch.failRequest' ? { errorReason: 'BlockedByClient' } : {}) };
      await cdp.send(method, args);
    })().catch(() => {}); });
    await cdp.send('Fetch.enable', { patterns: [{ urlPattern: '*', requestStage: 'Request' }] });
  }`
}
