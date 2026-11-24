import { readFile } from 'node:fs/promises'
import { z } from 'zod'

const Selector = z.string().min(1).max(300)
export const ExecutionRule = z.object({
  mode: z.enum(['debug', 'use']), origin: z.string().url(), paths: z.array(z.string().regex(/^\/(?!\/)[^?#]*$/)).min(1).max(10),
  scope: Selector, input: Selector, submit: Selector, output: Selector, busy: Selector, error: Selector,
}).strict()
export type ExecutionRule = z.infer<typeof ExecutionRule>
export const Site = z.object({
  name: z.string().min(1).max(100), url: z.string().url().max(2000),
  allowedOrigins: z.array(z.string().url()).min(1).max(20),
  blockedHosts: z.array(z.string().regex(/^[a-z0-9.-]+$/)).max(50).default([]),
  loginPaths: z.array(z.string().regex(/^\/(?!\/)[^?#]*$/).max(300)).max(20).default([]),
  navigationPaths: z.array(z.string().regex(/^\/(?!\/)[^?#]*$/).max(300)).max(20).default([]),
  navigationQueryKeys: z.array(z.string().regex(/^[a-zA-Z][a-zA-Z0-9_-]{0,50}$/)).max(20).default([]),
  approvalPaths: z.array(z.string().regex(/^\/(?!\/)[^?#]*$/).max(300)).max(20).default([]),
  execution: z.array(ExecutionRule).max(2).default([]),
  selectors: z.object({
    search: Selector, results: Selector, card: Selector, name: Selector, type: Selector,
    version: Selector, tags: Selector, description: Selector,
  }).strict().default({ search: ':not(*)', results: ':not(*)', card: ':not(*)', name: ':not(*)', type: ':not(*)', version: ':not(*)', tags: ':not(*)', description: ':not(*)' }),
  emptyText: z.string().min(1).max(100).default('No results'),
  screenshotMasks: z.array(Selector).max(20).default([]),
}).strict().superRefine((site, ctx) => {
  const url = new URL(site.url)
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) ctx.addIssue({ code: 'custom', message: 'Use a credential-free entry URL without query or fragment' })
  if (url.protocol === 'http:' && !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) ctx.addIssue({ code: 'custom', message: 'HTTP is restricted to local fixtures' })
  for (const origin of site.allowedOrigins) {
    const parsed = new URL(origin)
    if (parsed.origin !== origin || !['https:', 'http:'].includes(parsed.protocol) || parsed.username || parsed.password) ctx.addIssue({ code: 'custom', message: 'Expected an exact HTTP(S) origin' })
  }
  if (!isAllowed(site, site.url)) ctx.addIssue({ code: 'custom', message: 'Entry URL is not allowed' })
  if (new Set(site.execution.map(rule => rule.mode)).size !== site.execution.length) ctx.addIssue({ code: 'custom', message: 'Execution modes must be unique' })
  for (const rule of site.execution) if (new URL(rule.origin).origin !== rule.origin || !isAllowed(site, rule.origin)) ctx.addIssue({ code: 'custom', message: 'Execution origin must be explicitly allowed' })
})
export type Site = z.infer<typeof Site>
/** Self-contained so the isolated MCP page setup uses the same policy as the native service. */
export function createRequestPolicy(site: Pick<Site, 'allowedOrigins' | 'blockedHosts'>) {
  const permits = (value: string): boolean => {
    try {
      const url = new URL(value)
      return !url.username && !url.password && site.allowedOrigins.includes(url.origin)
        && !site.blockedHosts.some(host => url.hostname === host || url.hostname.endsWith(`.${host}`))
    } catch { return false }
  }
  const upgrade = (value: string): string | undefined => {
    try {
      const url = new URL(value)
      if (url.protocol !== 'http:' || permits(value)) return
      url.protocol = 'https:'
      if (permits(url.href)) return url.href
    } catch { /* Invalid URLs are denied by permits(). */ }
  }
  return { permits, upgrade }
}
export function isAllowed(site: Pick<Site, 'allowedOrigins' | 'blockedHosts'>, value: string): boolean {
  return createRequestPolicy(site).permits(value)
}
export function navigationUrl(site: Site, value?: string): string {
  if (!value) return site.url
  const url = new URL(value)
  if (!isAllowed(site, value) || url.origin !== new URL(site.url).origin || url.hash
    || ![new URL(site.url).pathname, ...site.navigationPaths].includes(url.pathname)
    || [...url.searchParams.keys()].some(key => !site.navigationQueryKeys.includes(key))) throw new Error('navigation-not-allowed')
  return url.href
}
export function allowsApproval(site: Site, value: string): boolean {
  const url = new URL(value)
  return url.origin === new URL(site.url).origin && site.approvalPaths.includes(url.pathname) && isAllowed(site, value)
}

export async function loadSite(path: string): Promise<Site> {
  const bytes = await readFile(path)
  if (bytes.length > 32_768) throw new Error('Site configuration exceeds 32 KiB')
  return Site.parse(JSON.parse(bytes.toString('utf8')))
}
