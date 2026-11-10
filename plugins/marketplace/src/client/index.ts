/** External Marketplace browser contribution. */

import { createElement } from 'react'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type { ConnectionHandle } from '@deepseek-ai/dsh-client-connection/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-plugin-manager/client'
import { MarketplacePanel } from './MarketplacePanel.tsx'
import { en, zh, type LocaleKey } from './locales.ts'
import type { MarketplaceRemote } from './types.ts'

const namespace = 'settings.marketplace.external'

type RpcResponse<T> = { ok: true; value: T } | { ok: false; error: { code: string; message: string } }

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    'settings.marketplace.external': LocaleKey
  }
}

export const name = '@shamcleren/dsh-plugin-marketplace'
export const inject = ['slots', 'locale', 'connection']

function unwrap<T>(response: Promise<RpcResponse<unknown>>): Promise<T> {
  return response.then((result) => {
    if (result.ok) return result.value as T
    throw new Error(`${result.error.code}: ${result.error.message}`)
  })
}

/** Mount the remote Marketplace on this installed bundle’s current plugin page. */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(namespace, { zh, en }), 'external-marketplace: dictionaries')
  const t = ctx.locale.bind(namespace)
  const connection = ctx.get('connection') as ConnectionHandle
  const call = <T>(endpoint: string, payload: unknown = {}): Promise<T> =>
    unwrap<T>(connection.rpc.call('/trusted-marketplace', endpoint, payload))
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
  ctx.slots.inject('plugins.bundle.config', () => ctx.slots.register({
    name: 'plugins.bundle.config',
    key: name,
    locale: namespace,
  }, () => createElement(MarketplacePanel, { remote, t })))
}
