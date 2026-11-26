import { createElement, Fragment } from 'react'
import type { Context } from '@deepseek-ai/cordis'
import type { ConnectionHandle } from '@deepseek-ai/dsh-client-connection/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-plugin-manager/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import { Panel } from './Panel.js'
import { css } from './styles.js'
import { en, zh, type LocaleKey } from './locales.js'
import { WeChatCardController } from '../adapters/wechat/client/controller.js'
import { WeComCardController } from '../adapters/wecom/client/controller.js'
import { cardApi } from '../adapters/wecom/client/api.js'
import { ChannelBadge as WeChatBadge } from '../adapters/wechat/client/index.js'
import { ChannelBadge as WeComBadge } from '../adapters/wecom/client/index.js'
import { en as wechatEn, zh as wechatZh } from '../adapters/wechat/client/locales.js'
import { en as wecomEn, zh as wecomZh } from '../adapters/wecom/client/locales.js'
import type { Config as WeChatConfig } from '../adapters/wechat/config.js'
import type { Config as WeComConfig } from '../adapters/wecom/config.js'
import wechatRemote from '../adapters/wechat/remote.js'
import { adapterViewsSchema } from '../contracts.js'

declare module '@deepseek-ai/dsh-client-ui-slots' { interface LocaleNamespaceMap { 'im.workbench': LocaleKey } }
export const name = '@shamcleren/dsh-im'
export const inject = ['remote']
function hasClientRpc(value: unknown): value is Pick<ConnectionHandle, 'rpc'> {
  return typeof value === 'object' && value !== null && 'rpc' in value
    && typeof value.rpc === 'object' && value.rpc !== null && 'call' in value.rpc && typeof value.rpc.call === 'function'
}
export async function apply(ctx: Context): Promise<() => Promise<void>> {
  const remote = await ctx.remote.$mount(wechatRemote)
  const fiber = ctx.inject(['slots', 'locale', 'connection', 'remote.wechatLogin', 'remote.credentials', 'remote.workspace', 'remote.agentPresets', 'configForms'], mount)
  return async () => { await fiber.dispose(); await remote() }
}
function mount(ctx: Context): void {
  const api = cardApi(ctx)
  const wechatForm = ctx.configForms.get<WeChatConfig>('wechat'), wecomForm = ctx.configForms.get<WeComConfig>('wecom-aibot')
  const wechat = new WeChatCardController(ctx.remote.wechatLogin, wechatForm, { list: () => api.presets.list({}) })
  const wecom = new WeComCardController(wecomForm, api)
  ctx.effect(() => () => { wechat.dispose(); wecom.dispose() }, 'IM settings controllers')
  ctx.effect(() => ctx.remote.$on('credentials/reference-updated', ref => wecom.refreshCredential(ref)), 'IM credential changes')
  ctx.effect(() => ctx.locale.register('im.workbench', { en, zh }), 'IM dictionaries')
  ctx.effect(() => ctx.locale.register('settings.wechat', { en: wechatEn, zh: wechatZh }), 'WeChat dictionaries')
  ctx.effect(() => ctx.locale.register('settings.wecom', { en: wecomEn, zh: wecomZh }), 'WeCom dictionaries')
  ctx.effect(() => { const element = document.createElement('style'); element.textContent = css; document.head.append(element); return () => element.remove() }, 'IM styles')
  const connection: unknown = ctx.get('connection')
  if (!hasClientRpc(connection)) throw new Error('IM settings require the public browser connection')
  const state = async () => {
    const result = await connection.rpc.call('/im', 'state', {})
    if (!result.ok) throw new Error('IM state unavailable')
    return adapterViewsSchema.parse(result.value)
  }
  const wechatT = ctx.locale.bind('settings.wechat'), wecomT = ctx.locale.bind('settings.wecom')
  ctx.slots.inject('plugins.bundle.config', () => ctx.slots.register({ name: 'plugins.bundle.config', key: name, locale: 'im.workbench' }, () => createElement(Panel, { t: ctx.locale.bind('im.workbench'), wechatT, wecomT, wechat, wecom, wechatForm, wecomForm, api, state })))
  ctx.slots.inject('conversation.session.header.actions', () => ctx.slots.register({ name: 'conversation.session.header.actions', id: 'im-session-badge', order: 20 }, (props: { sessionId: string }) => createElement(Fragment, null,
    createElement(WeChatBadge, { sessionId: props.sessionId, t: wechatT }), createElement(WeComBadge, { sessionId: props.sessionId, t: wecomT }))))
}
