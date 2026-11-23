import type { Page } from 'playwright'
import { mkdir, readFile, rename, writeFile, stat, unlink } from 'node:fs/promises'
import { dirname } from 'node:path'
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import type { ExecutionRule, Site } from './site.js'
import { ExecutionResult } from './agent-contract.js'

export const normalizeLabel = (label: string): string => label.replace(/[\s\uE000-\uF8FF]/g, '')
export const forbiddenLabel = (label: string): boolean => /保存|发布|删除|分享|权限|上传|下载|save|publish|delete|share|permission|upload|download/i.test(label)
export function executionRule(site: Site, url: string): ExecutionRule | undefined {
  const parsed = new URL(url)
  return site.execution.find(rule => rule.origin === parsed.origin && rule.paths.includes(parsed.pathname))
}

interface Pending { rule: ExecutionRule; page: Page; baseline: number; errors: string[]; result: ExecutionResult }
/** Owns submission receipts and DOM evidence; model prose never becomes execution output. */
export class Executions {
  readonly results: ExecutionResult[] = []
  private pending?: Pending
  private loaded?: Promise<void>
  constructor(private journal?: { path: string; sessionId: string; siteUrl: string }) {}

  load(): Promise<void> {
    return this.loaded ??= (async () => {
      if (!this.journal) return
      let raw: string
      try { if ((await stat(this.journal.path)).size > 1_048_576) throw new Error('execution-journal-too-large'); raw = await readFile(this.journal.path, 'utf8') } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error }
      const data = z.object({ sessionId: z.literal(this.journal.sessionId), siteUrl: z.literal(this.journal.siteUrl), results: z.array(ExecutionResult).max(20) }).strict().parse(JSON.parse(raw))
      this.results.push(...data.results.map(result => result.status === 'running' ? { ...result, status: 'uncertain' as const, error: 'interrupted-execution' } : result))
    })()
  }
  private async persist(): Promise<void> {
    if (!this.journal) return
    const { path, sessionId, siteUrl } = this.journal
    await mkdir(dirname(path), { recursive: true, mode: 0o700 })
    const temporary = path + '.' + randomUUID() + '.tmp'
    try {
      await writeFile(temporary, JSON.stringify({ sessionId, siteUrl, results: this.results }), { mode: 0o600, flag: 'wx' })
      await rename(temporary, path)
    } finally { await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error }) }
  }

  hasReceipt(id: string): boolean { return this.results.some(result => result.id === id) }
  async submit(page: Page, rule: ExecutionRule, id: string, selector: string): Promise<void> {
    if (this.hasReceipt(id)) return
    if (this.results.length >= 20) throw new Error('execution-limit')
    if (this.pending) throw new Error('execution-in-progress')
    if (this.results.some(result => result.mode === rule.mode && result.status === 'uncertain')) throw new Error('submission-uncertain')
    const scope = page.locator(rule.scope)
    if (await scope.count() !== 1 || !await scope.isVisible()) throw new Error('execution-control-unavailable')
    const input = scope.locator(rule.input), submit = scope.locator(rule.submit)
    if (await input.count() !== 1 || await submit.count() !== 1 || !await submit.isVisible()) throw new Error('execution-control-unavailable')
    const valid = await page.locator(selector).evaluate((el, rule) => el.matches(rule.submit) && !!el.closest(rule.scope), rule)
    if (!valid) throw new Error('execution-control-changed')
    const label = await submit.innerText()
    if (forbiddenLabel(label + ' ' + (await submit.getAttribute('aria-label') ?? '') + ' ' + (await submit.getAttribute('title') ?? ''))) throw new Error('execution-not-authorized')
    const safeInput = await input.evaluate(el => {
      const input = el as HTMLInputElement
      const label = el.getAttribute('aria-label') || el.getAttribute('aria-placeholder') || input.labels?.[0]?.textContent || el.getAttribute('placeholder') || el.getAttribute('name') || ''
      return input.type !== 'password' && !input.disabled && !input.readOnly && !/password|secret|token|api.?key|验证码|密码|密钥/i.test(label + ' ' + input.autocomplete)
    })
    if (!safeInput) throw new Error('execution-control-changed')
    const text = await input.evaluate(el => 'value' in el ? String((el as HTMLInputElement).value) : (el as HTMLElement).innerText)
    if (!text.trim() || text.length > 2000) throw new Error('invalid-message')
    if (await scope.locator(rule.busy).evaluateAll(elements => elements.some(el => el.getClientRects().length > 0 && getComputedStyle(el).visibility !== 'hidden'))) throw new Error('execution-in-progress')
    const baseline = await scope.locator(rule.output).count(), errors = await scope.locator(rule.error).evaluateAll(elements => elements.filter(el => el.getClientRects().length > 0 && getComputedStyle(el).visibility !== 'hidden').map(el => (el as HTMLElement).innerText.trim()))
    const now = new Date().toISOString()
    const result: ExecutionResult = { id, mode: rule.mode, input: text, output: '', status: 'running', url: page.url(), startedAt: now, updatedAt: now }
    this.results.push(result); this.pending = { rule, page, baseline, errors, result }
    try { await this.persist() } catch {
      // Nothing has been dispatched. Keep an explicit failed receipt and release the lock.
      result.status = 'failed'; result.error = 'execution-journal-unavailable'; delete this.pending
      throw new Error('execution-journal-unavailable')
    }
    // Record the attempt before dispatch: transport errors must not trigger another send.
    try { await submit.click({ timeout: 5000 }) }
    catch { result.status = 'uncertain'; result.error = 'submission-uncertain' }
    await this.refresh()
  }

  async refresh(): Promise<void> {
    const pending = this.pending
    if (!pending) return
    const { page, rule, baseline, errors, result } = pending
    if (page.isClosed() || page.url() !== result.url) {
      result.status = 'uncertain'; result.error = 'execution-page-changed'; delete this.pending; await this.persist(); return
    }
    const state = await page.evaluate(({ rule, baseline, errors }) => {
      const root = document.querySelector(rule.scope)
      if (!root || document.querySelectorAll(rule.scope).length !== 1) return null
      const visible = (el: Element) => el.getClientRects().length > 0 && getComputedStyle(el).visibility !== 'hidden'
      const text = (el: Element) => ((el as HTMLElement).innerText || '').trim()
      const output = Array.from(root.querySelectorAll(rule.output)).slice(baseline).filter(visible).map(text).filter(Boolean).join('\n\n').slice(0, 12000)
      const error = Array.from(root.querySelectorAll(rule.error)).filter(visible).map(text).filter(value => value && !errors.includes(value)).join('\n').slice(0, 2000)
      return { output, error, busy: Array.from(root.querySelectorAll(rule.busy)).some(visible) }
    }, { rule, baseline, errors })
    result.updatedAt = new Date().toISOString()
    if (!state) { result.status = 'uncertain'; result.error = 'execution-scope-unavailable'; delete this.pending; await this.persist(); return }
    result.output = state.output
    if (state.error) { result.status = 'failed'; result.error = state.error; delete this.pending }
    else if (state.output && !state.busy) { result.status = 'completed'; delete result.error; delete this.pending }
    else if (Date.now() - Date.parse(result.startedAt) > 90_000) { result.status = 'uncertain'; result.error = 'result-timeout'; delete this.pending }
    await this.persist()
  }

  async wait(signal: AbortSignal): Promise<void> {
    const pending = this.pending
    if (!pending) return
    signal.throwIfAborted()
    const { page, rule, baseline, errors } = pending
    await page.waitForFunction(({ rule, baseline, errors }) => {
      const root = document.querySelector(rule.scope)
      if (!root) return true
      const visible = (el: Element) => el.getClientRects().length > 0 && getComputedStyle(el).visibility !== 'hidden'
      const output = Array.from(root.querySelectorAll(rule.output)).slice(baseline).some(el => visible(el) && (el as HTMLElement).innerText.trim())
      const error = Array.from(root.querySelectorAll(rule.error)).some(el => visible(el) && !!(el as HTMLElement).innerText.trim() && !errors.includes((el as HTMLElement).innerText.trim()))
      return error || output && !Array.from(root.querySelectorAll(rule.busy)).some(visible)
    }, { rule, baseline, errors }, { timeout: 12_000 }).catch(error => { if (error.name !== 'TimeoutError') throw error })
    signal.throwIfAborted(); await this.refresh()
  }
}
