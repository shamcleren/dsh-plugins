import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
/** Browser half of the WeChat plugin: contributes its own settings card. */

import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type { RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import type {} from '@deepseek-ai/dsh-api-session-controller/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings-plugins/client'
import { createElement } from 'react'
import { WeChatCard } from './Card.js'
import { WeChatCardController } from './controller.js'
import { en, zh, type LocaleKey } from './locales.js'
import type { Config } from '../config.js'
import { isChannelSession } from '../channel-id.js'
import wechatLoginRemote from '../remote.js'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Copy owned by the external WeChat settings card. */
    'settings.wechat': LocaleKey
  }
}

const LOCALE_NAMESPACE = 'settings.wechat'
const SETTINGS_NAMESPACE = 'wechat'
const BADGE_CSS = `
.wechat-session-badge{display:inline-flex;align-items:center;gap:6px;border-radius:999px;padding:2px 8px;font:13px/1.45 ui-sans-serif,system-ui,sans-serif;color:#07c160;background:color-mix(in srgb,#07c160 14%,transparent)}
.wechat-session-mark{width:8px;height:8px;border-radius:999px;background:#07c160;box-shadow:0 0 0 2px color-mix(in srgb,#07c160 28%,transparent)}
`

export const inject = ['remote']

/** Register the WeChat card when the generic plugin-settings slot exists. */
export async function apply(ctx: ClientContext): Promise<() => Promise<void>> {
  const disposeRemote = await ctx.remote.$mount(wechatLoginRemote)
  const cardFiber = ctx.inject(
    ['slots', 'locale', 'remote', 'remote.wechatLogin', 'remote.agentPresets', 'settingsScope'],
    mountCard,
  )
  const badgeFiber = ctx.inject(['slots', 'locale', 'sessions'], mountSessionBadge as unknown as (ctx: ClientContext) => void)
  try {
    await cardFiber
  } catch (error) {
    await badgeFiber.dispose()
    await disposeRemote()
    throw error
  }
  return async () => {
    await cardFiber.dispose()
    await badgeFiber.dispose()
    await disposeRemote()
  }
}

function mountCard(ctx: ClientContext): () => void {
  const card = new WeChatCardController(
    ctx.remote.wechatLogin,
    ctx.settingsScope.bind<Config>({ namespace: SETTINGS_NAMESPACE }),
    { list: () => listPresets(ctx) },
  )
  ctx.effect(
    () => ctx.locale.register(LOCALE_NAMESPACE, { zh, en }),
    'wechat: browser dictionaries',
  )
  ctx.slots.inject('settings.plugin.item', () => ctx.slots.register({
      name: 'settings.plugin.item',
      key: SETTINGS_NAMESPACE,
      locale: LOCALE_NAMESPACE,
      inject: () => card.inject(),
    }, WeChatCard))
  return () => { card.dispose() }
}

function mountSessionBadge(ctx: SessionBadgeHost): void {
  ctx.effect(
    () => ctx.locale.register(LOCALE_NAMESPACE, { zh, en }),
    'wechat: session badge dictionary',
  )
  const t = ctx.locale.bind(LOCALE_NAMESPACE)
  ctx.slots.inject('conversation.session.header.actions', () => ctx.slots.register(
    { name: 'conversation.session.header.actions', id: 'wechat-session-badge', order: 20, locale: LOCALE_NAMESPACE },
    () => createElement(ChannelBadge, { sessionId: currentSessionId(ctx), t }),
  ))
}

interface SessionBadgeHost {
  locale: ClientContext['locale']
  effect: ClientContext['effect']
  slots: {
    inject(slot: string, register: () => unknown): void
    register(meta: Record<string, unknown>, component: () => unknown): unknown
  }
  sessions?: { list: { getSnapshot(): { current?: string } } }
}

function currentSessionId(ctx: SessionBadgeHost): string | undefined {
  return ctx.sessions?.list.getSnapshot().current
}

/** Header mark for the open personal WeChat Session. */
export function ChannelBadge(props: {
  sessionId: string | undefined
  t: (key: LocaleKey) => string
}): ReturnType<typeof createElement> | null {
  if (!isChannelSession(props.sessionId ?? '')) return null
  return createElement('span', { className: 'wechat-session-badge', title: props.t('sessionBadge') },
    createElement('style', null, BADGE_CSS),
    createElement('span', { className: 'wechat-session-mark', 'aria-hidden': true }),
    props.t('sessionBadge'))
}

async function listPresets(ctx: ClientContext): Promise<{ result: RemoteResult<{
  items: readonly { id: string; name?: string; broken?: string }[]
  defaultId?: string
}> }> {
  const result = await agentPresets(ctx).list()
  if (!result.ok) return { result }
  const defaultPreset = result.value.presets.find(preset => preset.isDefault)
  return { result: { ok: true, value: {
    items: result.value.presets.map(preset => ({
      id: preset.id,
      ...preset.name === undefined ? {} : { name: preset.name },
      ...preset.broken === undefined ? {} : { broken: preset.broken },
    })),
    ...defaultPreset === undefined ? {} : { defaultId: defaultPreset.id },
  } } }
}

function agentPresets(ctx: ClientContext): {
  list(): Promise<RemoteResult<{
    presets: readonly { id: string; name?: string; isDefault: boolean; broken?: string }[]
  }>>
} {
  return (ctx.remote as ClientContext['remote'] & {
    agentPresets: { list(): Promise<RemoteResult<{
      presets: readonly { id: string; name?: string; isDefault: boolean; broken?: string }[]
    }>> }
  }).agentPresets
}
