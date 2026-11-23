import { useEffect, useRef, useSyncExternalStore } from 'react'
import type { Context } from '@deepseek-ai/cordis'
import type { ConnectionHandle } from '@deepseek-ai/dsh-client-connection/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar-right/client'
import type {} from '@deepseek-ai/dsh-client-ui-tool/client'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import { AGENT_CHANNEL, BROWSER_TOOL, VIEW_TOOL, ASK_TOOL, AgentState, type AgentRemote } from '../agent-contract.js'
import { agentZh, agentEn, type AgentLocaleKey } from '../agent-locales.js'
import { AgentPanel, BrowserOverlay } from './AgentPanel.js'
import { agentStyles } from './agent-styles.js'
import { importedStyles } from './styles.js'

const namespace = 'saas.agent'
const kind = 'saas-agent-workspace'
export const name = '@shamcleren/dsh-saas-browser-workspace'
export const inject = ['slots', 'locale', 'connection', 'sidebarRightTabs', 'sidebarRight']
declare module '@deepseek-ai/dsh-client-ui-slots' { interface LocaleNamespaceMap { 'saas.agent': AgentLocaleKey } }

export function apply(ctx: Context): void {
  ctx.effect(() => ctx.locale.register(namespace, { zh: agentZh, en: agentEn }), 'saas-workspace: locale')
  const t = ctx.locale.bind(namespace)
  ctx.effect(() => {
    const element = document.createElement('style'); element.dataset.saasAgent = ''
    element.textContent = [...importedStyles, agentStyles].join('\n'); document.head.append(element)
    return () => element.remove()
  }, 'saas-workspace: styles')
  const connection = ctx.get('connection') as ConnectionHandle
  const remote: AgentRemote = {
    call: async (method, payload, signal) => {
      const result = await connection.rpc.call(AGENT_CHANNEL, method, payload, signal)
      if (!result.ok) throw new Error(result.error.code)
      return result.value
    },
    state: async (sessionId, signal) => AgentState.parse(await remote.call('state', { sessionId }, signal)),
    frame: async (sessionId, signal) => {
      const response = await fetch('/api/saas-agent/frame?' + new URLSearchParams({ sessionId }), { credentials: 'same-origin', cache: 'no-store', signal })
      if (!response.ok || !response.headers.get('content-type')?.startsWith('image/jpeg')) throw new Error('frame-unavailable')
      return response.blob()
    },
  }
  const requests = new EventTarget()
  ctx.slots.inject('shell.overlay', () => ctx.slots.register({ name: 'shell.overlay', id: `${name}:browser`, locale: namespace }, () => {
    const sessionId = useSyncExternalStore(listener => ctx.sidebarRight.mounted.subscribe(listener), () => ctx.sidebarRight.mounted.getSnapshot())
    return sessionId ? <BrowserOverlay key={sessionId} sessionId={sessionId} remote={remote} requests={requests} t={t} /> : null
  }))
  ctx.effect(() => ctx.sidebarRightTabs.register({ id: name, kind, title: () => t('title'), guide: [{ id: 'browser', order: 35, title: () => t('title'), description: () => t('subtitle') }] }), 'saas-workspace: tab')
  ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register({ name: 'sidebar.right.pane.tab', key: name, locale: namespace, inject: sessionId => ({ ownerSessionId: sessionId }) }, props => <AgentPanel key={props.ownerSessionId} sessionId={props.ownerSessionId} remote={remote} t={t} openBrowser={() => requests.dispatchEvent(new CustomEvent('open', { detail: props.ownerSessionId }))} />))
  for (const key of [BROWSER_TOOL, VIEW_TOOL, ASK_TOOL]) ctx.slots.inject('tool.call.toolview', () => ctx.slots.register({ name: 'tool.call.toolview', key, locale: namespace, inject: sessionId => ({ ownerSessionId: sessionId }) }, props => {
    const opened = useRef(false)
    const open = () => { if (ctx.sidebarRight.mounted.getSnapshot() === props.ownerSessionId) ctx.sidebarRight.openTab(kind) }
    useEffect(() => { if (!opened.current && props.phase !== 'preparing') { opened.current = true; open() } }, [props.phase, props.ownerSessionId])
    return <div className="saas-agent-toolbar"><strong>{t('title')}</strong><button onClick={open}>{t('title')} ↗</button></div>
  }))
}
