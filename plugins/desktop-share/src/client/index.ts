import { createElement, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import type { Context } from '@deepseek-ai/cordis'
import type { ConversationController } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import type {} from '@deepseek-ai/dsh-api-session-controller/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import { en, zh, type LocaleKey } from './locales.js'
import { parseBatches, type SharedBatch, type ShareTransport } from './transport.js'
import { ComposerBusy } from './admission.js'
import { SharePanel, panelCSS } from './panel.js'
import { removeDraft } from './drafts.js'
import { admitCurrent } from './current.js'

const namespace = 'desktop.share'
declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap { 'desktop.share': LocaleKey }
}

export const inject = ['slots', 'locale', 'conversation', 'sessions']

/** Uses the exported ConversationController attachment API of the pinned rc.1 runtime. */
export function apply(ctx: Context): void {
  const transport = (window as Window & { webkit?: { messageHandlers?: { dshShare?: ShareTransport } } }).webkit?.messageHandlers?.dshShare
  if (!transport) return
  const conversation = ctx.conversation as ConversationController
  if (typeof conversation.createDrafts !== 'function' || typeof conversation.releaseDraftAttachments !== 'function' || typeof conversation.resolveDraftAttachments !== 'function' || typeof conversation.releaseDraftAttachment !== 'function') throw new Error('desktop-share: incompatible conversation API')
  ctx.effect(() => ctx.locale.register(namespace, { zh, en }), 'desktop-share: dictionaries')
  const t = ctx.locale.bind(namespace)
  ctx.effect(() => {
    const style = document.createElement('style'); style.textContent = panelCSS; document.head.append(style)
    return () => style.remove()
  }, 'desktop-share: styles')
  let batches: SharedBatch[] = []
  let failed = false
  let stopped = false
  let refreshing = false
  const accepted = new Set<string>()
  const active = new Set<string>()
  const listeners = new Set<() => void>()
  const jobs = new Set<Promise<unknown>>()
  const aborts = new Set<AbortController>()
  const emit = () => { for (const listener of listeners) listener() }
  const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener) } }
  const track = <T,>(task: Promise<T>): Promise<T> => { jobs.add(task); void task.finally(() => jobs.delete(task)).catch(() => {}); return task }
  const refresh = async () => {
    if (stopped || refreshing) return
    refreshing = true
    try {
      const next = parseBatches(await transport.postMessage({ action: 'list' })).filter(batch => !accepted.has(batch.id))
      if (!stopped) { batches = next; failed = false; emit() }
    } catch { if (!stopped) { failed = true; emit() } }
    finally { refreshing = false }
  }
  ctx.effect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined
    const poll = async () => { await track(refresh()); if (!stopped) timer = setTimeout(() => { void poll() }, 5000) }
    void poll()
    return async () => { stopped = true; clearTimeout(timer); for (const abort of aborts) abort.abort(); await Promise.allSettled([...jobs]); listeners.clear() }
  }, 'desktop-share: owned inbox polling')

  function Panel() {
    const pending = useSyncExternalStore(subscribe, () => batches)
    const error = useSyncExternalStore(subscribe, () => failed)
    const list = useSyncExternalStore(listener => ctx.sessions.list.subscribe(listener), () => ctx.sessions.list.getSnapshot())
    const uploads = useSyncExternalStore(listener => conversation.fileUploads.subscribe(listener), () => conversation.fileUploads.getSnapshot())
    const [notice, setNotice] = useState('')
    const [busy, setBusy] = useState(false)
    const current = useRef<AbortController | undefined>(undefined)
    const sessionId = list.current
    const scope = sessionId ? ctx.sessions.scope(sessionId) : undefined
    const composer = scope ? conversation.input.for(scope) : undefined
    const input = useSyncExternalStore(listener => composer?.state.subscribe(listener) ?? (() => {}), () => composer?.state.getSnapshot())
    useEffect(() => {
      setBusy(false); setNotice('')
      return () => current.current?.abort()
    }, [sessionId])
    const add = async (batch: SharedBatch) => {
      if (busy || active.size) return
      setBusy(true); setNotice(''); active.add(batch.id)
      const abort = new AbortController(); current.current = abort; aborts.add(abort)
      try {
        await admitCurrent(transport!, batch, abort, conversation, () => {
          const id = ctx.sessions.list.getSnapshot().current
          const scope = id ? ctx.sessions.scope(id) : undefined
          return id && scope ? { sessionId: id, actions: conversation.input.for(scope) } : undefined
        }, listener => ctx.sessions.list.subscribe(listener))
        accepted.add(batch.id); batches = batches.filter(item => item.id !== batch.id); emit()
        try { await transport!.postMessage({ action: 'ack', batch: batch.id }) }
        catch { if (!abort.signal.aborted) setNotice(t('ackError')) }
      } catch (error) { if (!abort.signal.aborted) setNotice(t(error instanceof ComposerBusy ? 'busy' : 'error')) }
      finally { aborts.delete(abort); active.delete(batch.id); if (!abort.signal.aborted) setBusy(false) }
    }
    const dismiss = async (batch: SharedBatch) => {
      if (busy || active.size) return
      setBusy(true); active.add(batch.id)
      try {
        // The existing native acknowledgement archives the batch; originals remain recoverable.
        await transport!.postMessage({ action: 'ack', batch: batch.id })
        accepted.add(batch.id); batches = batches.filter(item => item.id !== batch.id); emit()
      } catch { if (!stopped) setNotice(t('dismissError')) }
      finally { active.delete(batch.id); if (!stopped) setBusy(false) }
    }
    const attachments = conversation.resolveDraftAttachments(input?.attachmentIds ?? [])
    const locked = !input || input.phase === 'adjudicating' || input.phase === 'submitting'
    if (!pending.length && !attachments.length && !notice && !error) return null
    return createElement(SharePanel, {
      t, pending, drafts: attachments.map(file => ({ id: file.id, name: file.file.name, status: uploads[file.id]?.status })),
      currentTitle: sessionId ? list.byId[sessionId]?.displayTitle ?? sessionId : undefined, busy, locked, notice: notice || (error ? t('error') : ''),
      onAdd: batch => { void track(add(batch)) },
      onDismiss: batch => { void track(dismiss(batch)) },
      onRemove: value => {
        if (!sessionId || locked || busy) return
        const id = input?.attachmentIds.find(id => id === value)
        const scope = ctx.sessions.scope(sessionId)
        if (!id || !scope) return
        if (!removeDraft(conversation.input.for(scope), conversation, id)) setNotice(t('busy'))
      },
      onRetry: value => {
        const id = input?.attachmentIds.find(id => id === value)
        if (id && sessionId && !locked) conversation.retryFileUpload(sessionId, id)
      },
      onRefresh: () => { void track(refresh().catch(() => { if (!stopped) setNotice(t('error')) })) },
      onReveal: () => { void track(transport!.postMessage({ action: 'reveal' }).catch(() => { if (!stopped) setNotice(t('error')) })) },
      onClearNotice: () => { setNotice(''); failed = false; emit() },
    })
  }
  ctx.slots.inject('shell.overlay', () => ctx.slots.register({ name: 'shell.overlay', id: 'desktop-share', locale: namespace }, Panel))
}
