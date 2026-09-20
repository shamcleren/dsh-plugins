/** Codex identity and live activity. A normal new session plus the Codex preset is the entry. */
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { createElement, useEffect, useState } from 'react'
import { en, zh, type LocaleKey } from './locales.js'
import { css } from './styles.js'
import { codexNoticeDefinition, codexViewDefinition } from '../conversation.js'
import { CODEX_CHANNEL, type CodexState } from '../ui-contract.js'

interface ClientContext {
  sessions?: { open(id: SessionId): void; list: { getSnapshot(): { current?: string; byId: Record<string, { cwd?: string }> } } }
  uiConversation: { events: { register(definition: ReturnType<typeof codexNoticeDefinition>): () => void }; views: { register(definition: ReturnType<typeof codexViewDefinition>): () => void } }
  effect(callback: () => unknown, label?: string): void
  locale: { register(namespace: string, dictionaries: { zh: Record<string, string>; en: Record<string, string> }): unknown; bind(namespace: string): (key: LocaleKey) => string }
  connection: { rpc: { call<T>(channel: string, endpoint: string, payload: unknown): Promise<{ ok: true; value: T } | { ok: false; error: { message: string } }> } }
  slots: { inject(slot: string, register: () => unknown): void; register(meta: Record<string, unknown>, component: (props: { wide?: boolean }) => unknown): unknown }
}

export const name = '@shamcleren/dsh-codex-controller'
export const inject = ['slots', 'locale', 'connection', 'sessions', 'uiConversation']
const namespace = 'codex.session'

export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(namespace, { zh, en }), 'codex-controller: dictionaries')
  ctx.effect(() => {
    const disposeEvent = ctx.uiConversation.events.register(codexNoticeDefinition())
    const disposeView = ctx.uiConversation.views.register(codexViewDefinition())
    return () => { disposeEvent(); disposeView() }
  }, 'codex-controller: conversation nodes')
  const t = ctx.locale.bind(namespace)
  const call = async <T>(method: string, payload: unknown = {}): Promise<T> => {
    const result = await ctx.connection.rpc.call<T>(CODEX_CHANNEL, method, payload)
    if (!result.ok) throw new Error(result.error.message)
    return result.value
  }
  const currentId = (): string | undefined => ctx.sessions?.list.getSnapshot().current
  ctx.slots.inject('conversation.session.header.actions', () => ctx.slots.register({ name: 'conversation.session.header.actions', id: 'codex-controller-badge', order: 20, locale: namespace }, () => createElement(Badge, { sessionId: currentId(), call, t })))
}

export function BadgeView(props: { state: CodexState | undefined; t: (key: LocaleKey) => string }) {
  if (!props.state?.present) return null
  const record = props.state.record
  const thread = record.threadId ? record.threadId.slice(0, 8) : props.t(record.status)
  return createElement('span', { className: 'codex-status' },
    createElement('span', { className: 'codex-badge', title: record.threadId ? props.t('badge') + ' · ' + thread : props.t('badge') },
      createElement('span', { className: 'codex-mark', 'aria-hidden': true }),
      props.t('badge')),
    createElement(QuotaView, { state: props.state, t: props.t }))
}

export function QuotaView(props: { state: CodexState | undefined; t: (key: LocaleKey) => string }) {
  const quota = props.state?.present ? props.state.quota : undefined
  if (!quota) return null
  const reset = quota.resetsAt ? props.t('resets') + ' ' + resetLabel(quota.resetsAt) : ''
  const value = props.t('remaining') + ' ' + quota.remaining + '%' + (reset ? ' · ' + reset : '')
  return createElement('span', { className: 'codex-quota', title: value },
    createElement('span', null, props.t('quota')),
    createElement('span', null, value))
}

export function resetLabel(epochMs: number, timeZone = 'Asia/Shanghai'): string {
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone, month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(epochMs))
  const part = (type: string) => parts.find(item => item.type === type)?.value ?? ''
  return Number(part('month')) + '/' + Number(part('day')) + ' ' + part('hour') + ':' + part('minute')
}

function Badge(props: { sessionId: string | undefined; call: <T>(method: string, payload?: unknown) => Promise<T>; t: (key: LocaleKey) => string }) {
  return createElement('span', null, createElement('style', null, css), createElement(BadgeView, { state: useCodexState(props.sessionId, props.call), t: props.t }))
}

function useCodexState(sessionId: string | undefined, call: <T>(method: string, payload?: unknown) => Promise<T>): CodexState | undefined {
  const [state, setState] = useState<CodexState | undefined>()
  useEffect(() => {
    if (!sessionId) { setState(undefined); return }
    let stop = false
    const load = () => { void call<CodexState>('state', { sessionId }).then(next => { if (!stop) setState(next) }).catch(() => { if (!stop) setState(undefined) }) }
    load()
    const timer = setInterval(load, 1000)
    return () => { stop = true; clearInterval(timer) }
  }, [sessionId, call])
  return state
}
