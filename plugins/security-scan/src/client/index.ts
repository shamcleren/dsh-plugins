import type { UiWorkspace } from '@deepseek-ai/dsh-client-ui-workspace/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { createElement, useSyncExternalStore } from 'react'
import { Workbench } from './Workbench.js'
import { en, zh, type LocaleKey } from './locales.js'
import { css } from './styles.js'
import { SECURITY_CHANNEL, ModelCatalogSchema, UiStateSchema, type UiRemote } from '../ui-contract.js'
interface ClientContext {
  uiWorkspace?: Pick<UiWorkspace, 'openSession'>
  effect(callback: () => unknown, label?: string): void
  locale: { register(namespace: string, dictionaries: { zh: Record<string, string>; en: Record<string, string> }): unknown; bind(namespace: string): (key: LocaleKey) => string }
  connection: { rpc: { call<T>(channel: string, endpoint: string, payload: unknown): Promise<{ ok: true; value: T } | { ok: false; error: { message: string } }> } }
  slots: { inject(slot: string, register: () => unknown): void; register(meta: Record<string, unknown>, component: (props: { wide?: boolean }) => unknown): unknown }
}
export const name = '@shamcleren/dsh-security-scan'
export const inject = ['slots', 'locale', 'connection', 'uiWorkspace']
const namespace = 'security.workspace'
export function reportLinkId(href: string, current: string): string | undefined {
  try {
    const url = new URL(href, current), page = new URL(current)
    return url.origin === page.origin && url.pathname === page.pathname && /^#dsh-security-report=[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u.test(url.hash) ? url.hash.slice('#dsh-security-report='.length) : undefined
  } catch { return undefined }
}
/** Additive sidebar navigation and an independent workbench, without replacing DSH's conversation. */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(namespace, { zh, en }), 'security-scan: client dictionaries')
  const t = ctx.locale.bind(namespace)
  const call = async <T>(method: string, payload: unknown = {}): Promise<T> => {
    const result = await ctx.connection.rpc.call<T>(SECURITY_CHANNEL, method, payload)
    if (!result.ok) throw new Error(result.error.message)
    return result.value
  }
  const remote: UiRemote = {
    models: async () => ModelCatalogSchema.parse(await call('models')),
    setup: () => call('setup'),
    state: async () => UiStateSchema.parse(await call('state')),
    save: (config, id, revision) => call('save', { config, ...(id ? { id, revision } : {}) }),
    removeRun: id => call('removeRun', { id }), removeReport: id => call('removeReport', { id }),
    remove: (id, revision) => call('remove', { id, revision }), run: (id, revision) => call('run', { id, revision }),
    cancel: id => call('cancel', { id }), settings: value => call('settings', value), hook: request => call('hook', request),
    source: (id, file, line) => call('source', { id, file, line }),
    report: (id, format) => call('report', { id, format }),
  }
  let requestedReport: string | undefined
  let opened = false
  const listeners = new Set<() => void>()
  const setOpen = (value: boolean): void => { opened = value; for (const listener of listeners) listener() }
  const subscribe = (listener: () => void): (() => void) => { listeners.add(listener); return () => listeners.delete(listener) }
  ctx.effect(() => () => { opened = false; listeners.clear() }, 'security-scan: view state')
  ctx.effect(() => {
    if (typeof window === 'undefined') return
    const open = (id: string) => { requestedReport = id; setOpen(true) }
    const onHash = () => { const id = reportLinkId(location.href, location.href); if (id) open(id) }
    const onClick = (event: MouseEvent) => {
      const link = event.target instanceof Element ? event.target.closest('a[href]') : null
      if (!link) return
      const id = reportLinkId(link.getAttribute('href')!, location.href)
      if (id) { event.preventDefault(); open(id) }
    }
    window.addEventListener('hashchange', onHash); document.addEventListener('click', onClick, true); onHash()
    return () => { window.removeEventListener('hashchange', onHash); document.removeEventListener('click', onClick, true) }
  }, 'security-scan: report links')
  ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register({ name: 'sidebar.footer.action', id: 'security-scan', order: 10, locale: namespace }, ({ wide }) => createElement('div', { className: 'security-nav-host' + (wide ? '' : ' rail') },
    createElement('style', null, css), createElement('button', { type: 'button', className: 'security-nav-trigger', title: t('entry'), 'aria-label': t('entry'), onClick: () => { requestedReport = undefined; setOpen(true) } },
      createElement('svg', { width: wide ? 16 : 18, height: wide ? 16 : 18, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.8, 'aria-hidden': true }, createElement('path', { d: 'M12 3 4 6v6c0 4 4 7 8 9 4-2 8-5 8-9V6L12 3Z' }), createElement('path', { d: 'm8 12 3 3 5-6' })), wide ? t('entry') : null))))
  function Surface() {
    const visible = useSyncExternalStore(subscribe, () => opened)
    return visible ? createElement(Workbench, { remote, t, ...(requestedReport ? { requestedReport } : {}), close: () => { requestedReport = undefined; setOpen(false) }, openSession: (id: string) => { if (!ctx.uiWorkspace) throw new Error('scan-session-unavailable'); ctx.uiWorkspace.openSession(id as SessionId); setOpen(false) } }) : null
  }
  ctx.slots.inject('shell.overlay', () => ctx.slots.register({ name: 'shell.overlay', id: 'security-scan-workspace', order: 50, locale: namespace }, Surface))
}
