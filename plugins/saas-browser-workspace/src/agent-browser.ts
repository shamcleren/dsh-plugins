import { observePage } from './page-observation.js'
import { randomUUID } from 'node:crypto'
import type { Page, BrowserContext, CDPSession, Request } from 'playwright'
import type { BrowserService } from '@anweat/dsh-browser'
import type { Site } from './site.js'
import { createRequestPolicy, navigationUrl } from './site.js'
import { BrowserArgs, type PageObservation, type Control, type HumanInput } from './agent-contract.js'
import { Executions, executionRule, normalizeLabel, forbiddenLabel } from './agent-execution.js'

const READ_LABELS = ['配置调试', '去配置调试', '查看配置', '查看详情', '详情', '基本信息', '模型配置', '提示词', '知识库', '工具', '返回', '搜索', '智能体开发', '管理我的智能体']
export interface LocatedControl extends Control { selector: string }

/** Adds bounded site navigation and explicitly registered chat actions to the public browser service. */
export class AgentBrowser {
  private page?: Page
  private context?: BrowserContext
  private cdps: CDPSession[] = []
  private pages = new Set<Page>()
  private allowPopup = false
  private popupAdmitted = false
  private popupRequests = new WeakSet<Request>()
  readonly executions: Executions
  private controls = new Map<string, LocatedControl>()
  private observation?: PageObservation
  private stopped = false
  blockedOrigin?: string
  constructor(private service: BrowserService, readonly sessionId: string, readonly site: Site, journalPath?: string) {
    this.executions = new Executions(journalPath ? { path: journalPath, sessionId, siteUrl: site.url } : undefined)
  }
  get ready(): boolean { return !!this.page && !this.page.isClosed() }
  get url(): string { return this.page?.url() ?? '' }
  get login(): boolean {
    if (!this.ready || this.url === 'about:blank') return false
    const url = new URL(this.url)
    return !executionRule(this.site, this.url) && (url.origin !== new URL(this.site.url).origin || this.site.loginPaths.includes(url.pathname))
  }

  async initialize(): Promise<void> {
    if (this.stopped) throw new Error('stopped')
    await this.executions.load()
    if (this.ready) return
    // read() initializes only about:blank; policy is attached before the first external navigation.
    await this.service.read({ session: `session:${this.sessionId}` })
    const state = this.service.sessionState({ id: this.sessionId })
    const page: Page | undefined = state?.page
    if (!page || typeof page.context !== 'function') throw new Error('browser-provider-incompatible')
    this.page = page; this.context = page.context(); this.pages.add(page)
    await page.setViewportSize({ width: 1280, height: 900 })
    await this.context.addInitScript(() => {
      // A fresh context has no existing workers. Keep new workers outside this browsing session.
      if ('serviceWorker' in navigator) Object.defineProperty(navigator, 'serviceWorker', { get: () => undefined, configurable: false })
    })
    await this.context.routeWebSocket('**/*', socket => socket.close())
    const policy = createRequestPolicy(this.site)
    await this.context.route('**/*', async route => {
      const request = route.request()
      // A use-page popup is admitted only during its observed navigation action.
      if (request.isNavigationRequest()) {
        let requestPage: Page | undefined
        try { requestPage = request.frame().page() } catch { /* A popup's initial request predates its frame. */ }
        if (!requestPage || !this.pages.has(requestPage)) {
          const previous = request.redirectedFrom()
          const admittedRedirect = !!previous && this.popupRequests.has(previous)
          const destination = policy.upgrade(request.url()) ?? request.url()
          if (this.allowPopup && (admittedRedirect || !this.popupAdmitted && executionRule(this.site, destination))) {
            this.popupAdmitted = true; this.popupRequests.add(request)
            if (requestPage) this.pages.add(requestPage)
          } else { await route.abort('blockedbyclient'); return }
        }
      }
      const secure = request.isNavigationRequest() && request.method() === 'GET' ? policy.upgrade(request.url()) : undefined
      if (secure) {
        await route.fulfill({ status: 307, headers: { location: secure, 'cache-control': 'no-store' }, body: '' }); return
      }
      if (!policy.permits(request.url())) {
        if (request.isNavigationRequest()) this.blockedOrigin = new URL(request.url()).origin
        await route.abort('blockedbyclient'); return
      }
      await route.continue()
    })
    await this.attach(page)
  }

  private async attach(page: Page): Promise<void> {
    const policy = createRequestPolicy(this.site)
    this.page = page; this.pages.add(page)
    await page.setViewportSize({ width: 1280, height: 900 })
    const cdp = await this.context!.newCDPSession(page); this.cdps.push(cdp)
    cdp.on('Fetch.requestPaused', event => {
      const secure = event.resourceType === 'Document' && event.request.method === 'GET' ? policy.upgrade(event.request.url) : undefined
      if (secure) {
        void cdp.send('Fetch.fulfillRequest', { requestId: event.requestId, responseCode: 307,
          responseHeaders: [{ name: 'Location', value: secure }, { name: 'Cache-Control', value: 'no-store' }], body: '' }).catch(() => {})
        return
      }
      const permitted = policy.permits(event.request.url)
      if (!permitted && event.resourceType === 'Document') this.blockedOrigin = new URL(event.request.url).origin
      void cdp.send(permitted ? 'Fetch.continueRequest' : 'Fetch.failRequest', {
        requestId: event.requestId, ...(!permitted ? { errorReason: 'BlockedByClient' as const } : {}),
      }).catch(() => {})
    })
    await cdp.send('Network.setBypassServiceWorker', { bypass: true })
    await cdp.send('Fetch.enable', { patterns: [{ urlPattern: '*', requestStage: 'Request' }] })
  }

  async act(raw: BrowserArgs, signal: AbortSignal): Promise<PageObservation | undefined> {
    const args = BrowserArgs.parse(raw)
    signal.throwIfAborted(); await this.initialize(); signal.throwIfAborted()
    let page = this.page!
    if (args.action === 'open') {
      delete this.blockedOrigin
      await page.goto(navigationUrl(this.site, args.url), { waitUntil: 'domcontentloaded', timeout: 30_000 })
    } else if (this.login) return undefined
    else if (args.action === 'wait') await this.executions.wait(signal)
    else if (args.action === 'back') {
      const response = await page.goBack({ waitUntil: 'domcontentloaded', timeout: 20_000 })
      if (!response && this.pages.size > 1) { const previous = [...this.pages].find(candidate => candidate !== page && !candidate.isClosed()); if (previous) this.page = previous }
    }
    else if (args.action === 'scroll') await page.mouse.wheel(0, args.delta ?? 600)
    else if (args.action === 'submit' && args.request_id && this.executions.hasReceipt(args.request_id)) { /* Return current evidence without another dispatch. */ }
    else if (['fill', 'press', 'click', 'submit'].includes(args.action)) {
      const target = this.resolve(args.observation_id, args.ref)
      const locator = page.locator(target.selector)
      if (page.url() !== this.observation?.url || await locator.count() !== 1 || !await locator.isVisible()) throw new Error('page-changed-observe-again')
      if (args.action === 'fill') {
        if (!target.canFill || target.sensitive) throw new Error('read-only')
        await this.validateInput(locator, target)
        if (target.purpose === 'message') {
          const rule = executionRule(this.site, page.url())
          if (!rule || !await locator.evaluate((el, rule) => el.matches(rule.input) && !!el.closest(rule.scope), rule)) throw new Error('execution-control-changed')
        }
        await locator.fill(args.text ?? '', { timeout: 5000 })
      } else if (args.action === 'press') {
        if (!target.canFill || target.purpose !== 'search') throw new Error('read-only')
        await this.validateInput(locator, target)
        const response = page.waitForResponse(r => new URL(r.url()).origin === new URL(this.site.url).origin && ['xhr', 'fetch'].includes(r.request().resourceType()), { timeout: 8000 }).catch(() => undefined)
        await locator.press('Enter', { timeout: 5000 }); await response
      } else if (args.action === 'submit') {
        const rule = executionRule(this.site, page.url())
        if (!rule || target.purpose !== 'submit' || !args.request_id) throw new Error('execution-not-authorized')
        await this.executions.submit(page, rule, args.request_id, target.selector)
      } else {
        if (!target.canClick) throw new Error('read-only')
        const label = await locator.getAttribute('aria-label') || (await locator.innerText().catch(() => '')).trim() || ''
        const allowed = [...READ_LABELS, ...(this.site.execution.length ? ['配置', '去使用'] : [])]
        if (label !== target.label || forbiddenLabel(label + ' ' + (await locator.getAttribute('title') ?? '')) || !allowed.includes(normalizeLabel(label))) throw new Error('page-changed-observe-again')
        if (normalizeLabel(label) === '去使用') {
          this.allowPopup = true; this.popupAdmitted = false
          const popup = page.waitForEvent('popup', { timeout: 4000 }).catch(() => undefined)
          try {
            await locator.click({ timeout: 5000 })
            const opened = await popup
            if (opened) {
              if (!this.popupAdmitted) { await opened.close(); throw new Error('popup-not-allowed') }
              await this.attach(opened); page = opened
            }
          } finally { this.allowPopup = false }
        } else await locator.click({ timeout: 5000 })
      }
    }
    signal.throwIfAborted()
    if (this.login) return undefined
    return this.observe()
  }

  private async validateInput(locator: ReturnType<Page['locator']>, target: LocatedControl): Promise<void> {
    const valid = await locator.evaluate((el, { target, search, masks }) => {
      const input = el as HTMLInputElement
      const label = el.getAttribute('aria-label') || el.getAttribute('aria-placeholder') || input.labels?.[0]?.textContent?.trim() || (el as HTMLElement).innerText?.trim().slice(0, 200) || el.getAttribute('placeholder') || el.getAttribute('title') || el.getAttribute('name') || el.tagName.toLowerCase()
      return !masks.some(selector => !!el.closest(selector)) && label === target.label && !input.disabled && !input.readOnly && input.type !== 'password'
        && !/password|secret|token|api.?key|验证码|密码|密钥/i.test(label + ' ' + input.autocomplete)
        && (target.purpose !== 'search' || el.matches(search))
    }, { target, search: this.site.selectors.search, masks: this.site.screenshotMasks })
    if (!valid) throw new Error('page-changed-observe-again')
  }

  resolve(observationId?: string, ref?: string): LocatedControl {
    if (!observationId || observationId !== this.observation?.id || !ref) throw new Error('stale-observation')
    const control = this.controls.get(ref)
    if (!control) throw new Error('unknown-control')
    return control
  }

  async observe(): Promise<PageObservation> {
    const page = this.page!
    if (this.login) throw new Error('login-required')
    await page.waitForLoadState('domcontentloaded', { timeout: 10_000 })
    const rule = executionRule(this.site, page.url())
    const result = await page.evaluate(observePage, { selectors: this.site.selectors, readLabels: [...READ_LABELS, ...(this.site.execution.length ? ['配置', '去使用'] : [])], rule, emptyText: this.site.emptyText, masks: this.site.screenshotMasks })
    this.controls = new Map(result.controls.map(control => [control.ref, control]))
    const observation: PageObservation = { ...result, id: randomUUID(), url: page.url(), capturedAt: new Date().toISOString(), controls: result.controls.map(({ selector: _selector, ...control }) => control) }
    this.observation = observation
    await this.executions.refresh()
    return observation
  }

  async frame(): Promise<Buffer> {
    if (!this.ready) throw new Error('browser-not-ready')
    // Frames are transient owner-only transport; they never enter the model or durable history.
    return this.page!.screenshot({ type: 'jpeg', quality: 65, timeout: 5000 })
  }

  async input(input: HumanInput): Promise<void> {
    if (!this.ready) throw new Error('browser-not-ready')
    const page = this.page!
    if (!this.login) {
      if (input.kind === 'scroll') { await page.mouse.wheel(0, input.delta); return }
      // Business pages remain read-only during takeover. Login pages accept native input.
      if (input.kind !== 'click') throw new Error('read-only')
      const label = await page.evaluate(({ x, y }) => {
        const el = document.elementFromPoint(x, y)?.closest('button,a,[role=button],[role=tab]')
        const label = el?.getAttribute('aria-label') || (el as HTMLElement | null)?.innerText?.trim() || ''
        return /保存|发布|删除|分享|权限|save|publish|delete|share|permission/i.test(label + ' ' + (el?.getAttribute('title') ?? '')) ? '' : label
      }, input)
      if (!READ_LABELS.includes(label.replace(/\s+/g, ''))) throw new Error('read-only')
    }
    if (input.kind === 'click') await page.mouse.click(input.x, input.y)
    else if (input.kind === 'text') await page.keyboard.insertText(input.text)
    else if (input.kind === 'key') await page.keyboard.press(input.key)
    else await page.mouse.wheel(0, input.delta)
  }
  async close(): Promise<void> {
    this.stopped = true
    await Promise.allSettled(this.cdps.map(cdp => cdp.detach()))
    await Promise.allSettled([...this.pages].map(page => page.close()))
    const state = this.service.sessionState({ id: this.sessionId })
    if (state) await this.service.closePage(state)
  }
}
