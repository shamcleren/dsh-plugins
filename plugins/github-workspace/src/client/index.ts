import { createElement } from 'react'
import type { Context } from '@deepseek-ai/cordis'
import type { ConnectionHandle } from '@deepseek-ai/dsh-client-connection/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-plugin-manager/client'
import type { Remote } from '../types.js'
import { Panel, styles } from './Panel.js'
import { en, zh, type LocaleKey } from './locales.js'

const namespace = 'github.workspace'
declare module '@deepseek-ai/dsh-client-ui-slots' { interface LocaleNamespaceMap { 'github.workspace': LocaleKey } }
export const name = '@shamcleren/dsh-github-workspace'
export const inject = ['slots', 'locale', 'connection']
export function apply(ctx: Context): void {
  ctx.effect(() => ctx.locale.register(namespace, { zh, en }), 'github-workspace: dictionaries')
  ctx.effect(() => { const style = document.createElement('style'); style.textContent = styles; document.head.append(style); return () => style.remove() }, 'github-workspace: styles')
  const connection = ctx.get('connection') as ConnectionHandle
  const call = async <T>(method: string, payload: unknown = {}): Promise<T> => {
    const result = await connection.rpc.call('/github-workspace', method, payload)
    if (!result.ok) throw new Error(result.error.code)
    return result.value as T
  }
  const remote: Remote = {
    state: () => call('state'), initialize: () => call('initialize'), beginLogin: () => call('beginLogin'), cancelLogin: () => call('cancelLogin'),
    encryption: fullName => call('encryption', { fullName }), configureEncryption: (fullName, encryption) => call('configureEncryption', { fullName, encryption }),
    owners: () => call('owners'), repositories: (page, owner) => call('repositories', { page, ...(owner ? { owner } : {}) }), open: fullName => call('open', { fullName }),
    startOpen: fullName => call('startOpen', { fullName }), activity: () => call('activity'), cancelTask: id => call('cancelTask', { id }),
    configureSync: (fullName, enabled, intervalMinutes) => call('configureSync', { fullName, enabled, intervalMinutes }), startSync: fullName => call('startSync', { fullName }),
    status: fullName => call('status', { fullName }), fetch: fullName => call('fetch', { fullName }), pull: fullName => call('pull', { fullName }),
    preview: (fullName, paths) => call('preview', { fullName, paths }), commit: (id, message) => call('commit', { id, message }), push: (fullName, head) => call('push', { fullName, head }),
  }
  const t = ctx.locale.bind(namespace)
  ctx.slots.inject('plugins.bundle.config', () => ctx.slots.register({ name: 'plugins.bundle.config', key: name, locale: namespace }, () => createElement(Panel, { remote, t })))
}
