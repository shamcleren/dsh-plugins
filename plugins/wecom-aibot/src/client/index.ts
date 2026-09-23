import { cardApi } from './api.js'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
/** Browser half of the WeCom plugin: contributes its own settings card. */

import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import type {} from '@deepseek-ai/dsh-api-session-controller/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type {} from '@deepseek-ai/dsh-client-ui-plugin-manager/client'
import { createElement } from 'react'
import { WeComCard } from './Card.js'
import { WeComCardController } from './controller.js'
import { en, zh, type LocaleKey } from './locales.js'
import type { Config } from '../config.js'
import { isChannelSession } from '../channel-id.js'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Copy owned by the external WeCom settings card. */
    'settings.wecom': LocaleKey
  }
}

const LOCALE_NAMESPACE = 'settings.wecom'
const SETTINGS_NAMESPACE = 'wecom-aibot'
const BADGE_CSS = `
.wecom-session-badge{display:inline-flex;align-items:center;gap:6px;border-radius:999px;padding:2px 8px;font:13px/1.45 ui-sans-serif,system-ui,sans-serif;color:#2672ff;background:color-mix(in srgb,#2672ff 14%,transparent)}
.wecom-session-mark{width:8px;height:8px;border-radius:999px;background:#2672ff;box-shadow:0 0 0 2px color-mix(in srgb,#2672ff 28%,transparent)}
`

/**
 * Each Remote namespace is its own Cordis service keyed `remote.<namespace>`;
 * injecting `remote` alone resolves the mount point but not the namespaces this
 * card calls, and every call then throws before reaching the wire.
 */
export const inject = ['slots', 'locale', 'connection', 'remote', 'remote.credentials', 'remote.workspace', 'remote.agentPresets', 'settingsScope']

/** Register the WeCom card when the generic plugin-settings slot exists. */
export function apply(ctx: ClientContext): void {
  const api = cardApi(ctx)
  const scope = ctx.settingsScope.bind<Config>({ namespace: SETTINGS_NAMESPACE })
  const card = new WeComCardController(
    scope,
    api,
  )
  ctx.effect(
    () => ctx.locale.register(LOCALE_NAMESPACE, { zh, en }),
    'wecom-aibot: browser dictionaries',
  )
  ctx.effect(
    () => ctx.remote.$on('credentials/reference-updated', ref => { card.refreshCredential(ref) }),
    'wecom-aibot: credential invalidations',
  )
  ctx.slots.inject('plugins.bundle.config', () => ctx.slots.register({
      name: 'plugins.bundle.config',
      key: '@shamcleren/dsh-wecom-aibot',
      locale: LOCALE_NAMESPACE,
      inject: () => card.inject(),
    }, WeComCard))
  ctx.inject(['sessions'], mountSessionBadge as unknown as (ctx: ClientContext) => void)
}

function mountSessionBadge(ctx: SessionBadgeHost): void {
  const t = ctx.locale.bind(LOCALE_NAMESPACE)
  ctx.slots.inject('conversation.session.header.actions', () => ctx.slots.register(
    { name: 'conversation.session.header.actions', id: 'wecom-session-badge', order: 20, locale: LOCALE_NAMESPACE },
    (props: { sessionId: string }) => createElement(ChannelBadge, { sessionId: props.sessionId, t }),
  ))
}

interface SessionBadgeHost {
  locale: ClientContext['locale']
  slots: {
    inject(slot: string, register: () => unknown): void
    register(meta: Record<string, unknown>, component: (props: { sessionId: string }) => unknown): unknown
  }
}

/** Header mark for the open WeCom Session. */
export function ChannelBadge(props: {
  sessionId: string | undefined
  t: (key: LocaleKey) => string
}): ReturnType<typeof createElement> | null {
  if (!isChannelSession(props.sessionId ?? '')) return null
  return createElement('span', { className: 'wecom-session-badge', title: props.t('sessionBadge') },
    createElement('style', null, BADGE_CSS),
    createElement('span', { className: 'wecom-session-mark', 'aria-hidden': true }),
    props.t('sessionBadge'))
}
