/** External Marketplace browser contribution. */

import { createElement } from 'react'
import { MarketplacePanel } from './MarketplacePanel.tsx'
import { en, zh, type LocaleKey } from './locales.ts'
import type { MarketplaceRemote } from './types.ts'

const namespace = 'settings.marketplace.external'

type RpcResponse<T> = { ok: true; value: T } | { ok: false; error: { code: string; message: string } }

interface ClientContext {
  effect(callback: () => unknown, label?: string): void
  locale: {
    register(namespace: string, dictionaries: { zh: Record<string, string>; en: Record<string, string> }): unknown
    bind(namespace: string): (key: LocaleKey) => string
  }
  connection: { rpc: { call<T>(channel: string, endpoint: string, payload: unknown): Promise<RpcResponse<T>> } }
  slots: {
    inject(slot: string, register: () => unknown): void
    register(meta: Record<string, unknown>, component: (props?: unknown) => unknown): unknown
  }
}

export const name = '@shamcleren/dsh-plugin-marketplace'
export const inject = ['slots', 'locale', 'connection']

function unwrap<T>(response: Promise<RpcResponse<T>>): Promise<T> {
  return response.then((result) => {
    if (result.ok) return result.value
    throw new Error(`${result.error.code}: ${result.error.message}`)
  })
}

/** Add a remote Marketplace tab alongside the upstream Marketplace. */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(namespace, { zh, en }), 'external-marketplace: dictionaries')
  const t = ctx.locale.bind(namespace)
  const call = <T>(endpoint: string, payload: unknown = {}): Promise<T> =>
    unwrap(ctx.connection.rpc.call<T>('/trusted-marketplace', endpoint, payload))
  const remote: MarketplaceRemote = {
    state: () => call('state'),
    catalog: () => call('catalog'),
    refreshCatalog: () => call('refreshCatalog'),
    configure: request => call('configure', request),
    add: packageName => call('add', { packageName }),
    deletePackage: packageName => call('deletePackage', { packageName }),
    beginOAuth: request => call('beginOAuth', request),
    oauthStatus: flowId => call('oauthStatus', { flowId }),
  }
  ctx.slots.inject('settings.plugins.tab', () => ctx.slots.register({
    name: 'settings.plugins.tab',
    id: 'trusted-marketplace',
    order: 20,
    label: () => t('tab'),
    locale: namespace,
  }, () => createElement(MarketplacePanel, { remote, t })))
}
