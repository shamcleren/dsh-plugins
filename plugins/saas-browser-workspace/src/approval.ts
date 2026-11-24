import { createHash, randomUUID } from 'node:crypto'
import type { ElementHandle, Page } from 'playwright'
import type { ActionReview, BrowserArgs, PageField } from './agent-contract.js'
import type { observePage } from './page-observation.js'

type Snapshot = ReturnType<typeof observePage>
type Target = Snapshot['controls'][number]
type ReviewedAction = ActionReview['action']
type Handle = ElementHandle<SVGElement | HTMLElement>
const lifetimeMs = 5 * 60_000
const digest = (data: unknown) => createHash('sha256').update(JSON.stringify(data)).digest('hex')
const screenshotMasks = 'input[type=password],input[type=hidden],[autocomplete=one-time-code],[autocomplete=current-password],[autocomplete=new-password]'

interface Pending {
  review: ActionReview
  handle: Handle
  page: Page
  target: Target
  fingerprint: string
  screenshot: Buffer
  value: string
  timer?: ReturnType<typeof setTimeout>
}

/** Owns a single, transient approval. Only the owner RPC can consume it. */
export class Approvals {
  private pending: Pending | undefined
  get review(): ActionReview | undefined { return this.pending?.review }
  frame(id: string): Buffer {
    const pending = this.pending
    if (!pending || pending.review.id !== id || Date.now() >= Date.parse(pending.review.expiresAt)) throw new Error('stale-approval')
    return pending.screenshot
  }

  async prepare(page: Page, target: Target, action: ReviewedAction, args: BrowserArgs, snapshot: () => Promise<Snapshot>, masks: string[]): Promise<void> {
    if (this.pending || !target.approval?.includes(action)) throw new Error('read-only')
    const url = page.url()
    const handle = await page.locator(target.selector).elementHandle({ timeout: 5000 })
    try {
      const value = args.text ?? ''
      const next = action === 'select' ? target.options?.find(option => option.value === value) : undefined
      if (action === 'select' && !next) throw new Error('invalid-option')
      await handle.scrollIntoViewIfNeeded({ timeout: 5000 })
      const viewport = page.viewportSize(), bounds = await handle.boundingBox()
      if (!viewport || !bounds) throw new Error('approval-preview-unavailable')
      const left = Math.max(0, bounds.x), top = Math.max(0, bounds.y)
      const width = Math.min(viewport.width, bounds.x + bounds.width) - left, height = Math.min(viewport.height, bounds.y + bounds.height) - top
      if (width <= 0 || height <= 0) throw new Error('approval-preview-unavailable')
      const before = await this.evidence(page, handle, target, action, url, snapshot)
      const screenshot = await page.screenshot({
        type: 'jpeg', quality: 78, timeout: 5000,
        mask: [...masks, screenshotMasks, ...before.snapshot.controls.filter(control => control.sensitive).map(control => control.selector)].map(selector => page.locator(selector)),
        maskColor: '#162234',
      })
      const after = await this.evidence(page, handle, target, action, url, snapshot)
      const currentBounds = await handle.boundingBox()
      if (before.fingerprint !== after.fingerprint || !currentBounds
        || (['x', 'y', 'width', 'height'] as const).some(key => Math.abs(bounds[key] - currentBounds[key]) > 1)) {
        throw new Error('page-changed-observe-again')
      }
      const fields = after.fields.slice(0, 24)
      const review: ActionReview = {
        id: randomUUID(), action, label: target.label, url, pageTitle: after.snapshot.title,
        expiresAt: new Date(Date.now() + lifetimeMs).toISOString(),
        ...(action !== 'click' ? { before: target.value, after: next?.label ?? value } : {}),
        fields, fieldsLimited: after.fields.length > fields.length || !!after.snapshot.document?.truncated,
        target: { left: left * 100 / viewport.width, top: top * 100 / viewport.height,
          width: width * 100 / viewport.width, height: height * 100 / viewport.height },
      }
      const pending: Pending = { review, handle, page, target, screenshot, value, fingerprint: after.fingerprint }
      pending.timer = setTimeout(() => { if (this.pending === pending) void this.clear() }, lifetimeMs)
      pending.timer.unref()
      this.pending = pending
    } catch (error) {
      await handle.dispose().catch(() => {})
      throw error
    }
  }

  private async evidence(page: Page, handle: Handle, target: Target, action: ReviewedAction, url: string, snapshot: () => Promise<Snapshot>) {
    if (page.isClosed() || page.url() !== url) throw new Error('stale-approval')
    const observed = await snapshot()
    const current = observed.controls.find(control => control.selector === target.selector)
    if (page.url() !== url || !current?.approval?.includes(action) || current.label !== target.label || current.value !== target.value
      || JSON.stringify(current.options) !== JSON.stringify(target.options)) throw new Error('stale-approval')
    const identity = await handle.evaluate((el, selector) => {
      if (!el.isConnected || document.querySelector(selector) !== el || el.closest('[inert],[aria-disabled=true],dialog:not([open])')) return null
      const input = el as HTMLInputElement
      if (input.disabled || el.matches(':disabled')) return null
      // Attributes, form destination and the observed DOM node are checked again before dispatch.
      const form = input.form ?? el.closest('form')
      return [el.outerHTML, form?.getAttribute('action'), form?.getAttribute('method'), form?.getAttribute('target')]
    }, target.selector)
    if (!identity || page.url() !== url) throw new Error('stale-approval')
    const fields: PageField[] = observed.document.blocks.flatMap(block => block.kind === 'fields' ? block.fields : [])
    return { snapshot: observed, fields, fingerprint: digest([identity, observed.title, fields, observed.document.blocks]) }
  }

  async apply(id: string, page: Page, snapshot: () => Promise<Snapshot>, signal: AbortSignal): Promise<void> {
    const pending = this.pending
    if (!pending || pending.review.id !== id) throw new Error('stale-approval')
    // Consume before any await. Reload, double-click and transport retry never replay an action.
    this.pending = undefined
    clearTimeout(pending.timer)
    try {
      const { review, handle, target, value } = pending
      if (page !== pending.page || Date.now() >= Date.parse(review.expiresAt)) throw new Error('stale-approval')
      const { fingerprint } = await this.evidence(page, handle, target, review.action, review.url, snapshot)
      if (fingerprint !== pending.fingerprint || page.url() !== review.url) throw new Error('stale-approval')
      signal.throwIfAborted()
      try {
        if (review.action === 'click') await handle.click({ timeout: 5000 })
        if (review.action === 'fill') await handle.fill(value, { timeout: 5000 })
        if (review.action === 'select') await handle.selectOption({ value }, { timeout: 5000 })
      } catch { throw new Error('approval-result-uncertain') }
    } finally { await pending.handle.dispose().catch(() => {}) }
  }

  async clear(id?: string): Promise<void> {
    const pending = this.pending
    if (id && pending?.review.id !== id) throw new Error('stale-approval')
    if (!pending) return
    this.pending = undefined
    clearTimeout(pending.timer)
    await pending.handle.dispose().catch(() => {})
  }
}
