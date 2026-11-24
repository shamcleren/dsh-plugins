import { useEffect, useRef, useState } from 'react'
import type { AgentRemote, HumanInput } from '../agent-contract.js'
import type { AgentTranslate } from '../agent-locales.js'
import { INITIAL_VIEWPORT, type LiveFrame, type LiveSurface } from '../live-protocol.js'
import { errorHint } from './agent-errors.js'

type Props = {
  sessionId: string
  remote: AgentRemote
  t: AgentTranslate
  human: boolean
  keyboard?: boolean
  fit?: boolean
}

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value))
const keys = ['Enter', 'Tab', 'Backspace', 'Delete', 'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End'] as const

export function LiveBrowser({ sessionId, remote, t, human, keyboard = false, fit = false }: Props) {
  const canvas = useRef<HTMLCanvasElement>(null)
  const editor = useRef<HTMLTextAreaElement>(null)
  const sizing = useRef<HTMLDivElement>(null)
  const composing = useRef(false)
  const [connection, setConnection] = useState<'loading' | 'live' | 'lost'>('loading')
  const [error, setError] = useState('')
  const surface = useRef<LiveSurface | undefined>(undefined)
  const permission = useRef(false)
  permission.current = human && connection === 'live'
  const queue = useRef<{ input: HumanInput; epoch: number }[]>([])
  const loop = useRef(false)
  const raf = useRef(0)

  useEffect(() => {
    const lifetime = new AbortController()
    let current: AbortController | undefined
    let retry: ReturnType<typeof setTimeout> | undefined
    let watchdog: ReturnType<typeof setInterval> | undefined
    let epoch = 0, packetsAt = 0, frameAt = 0
    let pending: LiveFrame | undefined
    let drawing = false

    function reset() {
      surface.current = undefined
      permission.current = false
      queue.current = []
      pending = undefined
    }
    async function draw(source: AbortController) {
      if (drawing) return
      drawing = true
      try {
        while (pending && !source.signal.aborted) {
          const frame = pending
          pending = undefined
          const bitmap = await createImageBitmap(new Blob([frame.jpeg], { type: 'image/jpeg' }))
          try {
            if (source.signal.aborted || frame.epoch !== epoch || !canvas.current) continue
            const target = canvas.current
            if (target.width !== bitmap.width || target.height !== bitmap.height) {
              target.width = bitmap.width; target.height = bitmap.height
            }
            target.getContext('2d', { alpha: false })?.drawImage(bitmap, 0, 0)
            surface.current = frame
            setConnection('live')
          } finally { bitmap.close() }
        }
      } catch { source.abort() }
      finally {
        drawing = false
        if (pending && current && !current.signal.aborted) void draw(current)
      }
    }
    function connect() {
      const source = new AbortController()
      current = source
      reset()
      epoch = 0; packetsAt = performance.now(); frameAt = packetsAt
      watchdog = setInterval(() => {
        const now = performance.now()
        if (now - packetsAt > 4500 || (!surface.current && now - frameAt > 4500)) source.abort()
      }, 1000)
      void remote.live(sessionId, source.signal, packet => {
        if (source.signal.aborted) return
        packetsAt = performance.now()
        if (packet.epoch !== epoch) {
          epoch = packet.epoch; frameAt = packetsAt
          reset()
          setConnection(previous => previous === 'live' ? 'loading' : previous)
        }
        if ('jpeg' in packet) {
          pending = packet
          void draw(source)
        }
      }).catch(() => {}).finally(() => {
        clearInterval(watchdog)
        source.abort()
        if (lifetime.signal.aborted) return
        reset()
        setConnection('lost')
        retry = setTimeout(connect, 650)
      })
    }
    connect()
    return () => {
      lifetime.abort(); current?.abort()
      clearTimeout(retry); clearInterval(watchdog)
      cancelAnimationFrame(raf.current); raf.current = 0
      reset()
    }
  }, [remote, sessionId])

  useEffect(() => {
    if (!human || !fit || !sizing.current) return
    let timer: ReturnType<typeof setTimeout> | undefined
    const observer = new ResizeObserver(([entry]) => {
      if (!entry) return
      clearTimeout(timer)
      const width = clamp(Math.round(entry.contentRect.width / 16) * 16, 480, 1600)
      const height = clamp(Math.round(window.innerHeight * .65 / 16) * 16, 480, 1024)
      timer = setTimeout(() => { void remote.call('resizeBrowser', { sessionId, width, height }).catch(() => {}) }, 200)
    })
    observer.observe(sizing.current)
    return () => { clearTimeout(timer); observer.disconnect() }
  }, [human, fit, remote, sessionId])

  useEffect(() => {
    if (!human) { queue.current = []; setError('') }
  }, [human])

  async function flush() {
    if (loop.current) return
    loop.current = true
    try {
      while (queue.current.length && permission.current) {
        const next = queue.current.shift()!
        if (next.epoch !== surface.current?.epoch) continue
        try {
          await remote.call('input', { sessionId, epoch: next.epoch, input: next.input })
          setError('')
        } catch (cause) {
          queue.current = []
          if (permission.current) setError(errorHint(cause instanceof Error ? cause.message : undefined, t))
        }
      }
    } finally { loop.current = false }
  }
  function send(input: HumanInput) {
    const current = surface.current
    if (!permission.current || !current) return
    const last = queue.current.at(-1)
    if (input.kind === 'scroll' && last?.input.kind === 'scroll' && last.epoch === current.epoch) {
      last.input = { ...input,
        delta: clamp(last.input.delta + input.delta, -1200, 1200),
        deltaX: clamp((last.input.deltaX ?? 0) + (input.deltaX ?? 0), -1200, 1200),
      }
    } else if (queue.current.length < 40) queue.current.push({ input, epoch: current.epoch })
    if (!raf.current) raf.current = requestAnimationFrame(() => { raf.current = 0; void flush() })
  }
  function point(clientX: number, clientY: number, element: HTMLCanvasElement) {
    const current = surface.current
    if (!current) return
    const box = element.getBoundingClientRect()
    if (!box.width || !box.height) return
    return {
      x: clamp((clientX - box.left) * current.width / box.width, 0, current.width - 1),
      y: clamp((clientY - box.top) * current.height / box.height, 0, current.height - 1),
    }
  }
  // React's delegated wheel listener is passive. Prevent the surrounding panel scrolling during takeover.
  const wheelHandler = useRef<(event: WheelEvent) => void>(() => {})
  wheelHandler.current = event => {
    if (!permission.current || !canvas.current) return
    event.preventDefault()
    const coords = point(event.clientX, event.clientY, canvas.current)
    if (!coords) return
    const scale = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? surface.current?.height ?? 480
      : (surface.current?.width ?? 480) / (canvas.current.clientWidth || 480)
    send({ kind: 'scroll', ...coords, delta: clamp(Math.round(event.deltaY * scale), -1200, 1200),
      deltaX: clamp(Math.round(event.deltaX * scale), -1200, 1200) })
  }
  useEffect(() => {
    const element = canvas.current
    const wheel = (event: WheelEvent) => wheelHandler.current(event)
    element?.addEventListener('wheel', wheel, { passive: false })
    return () => element?.removeEventListener('wheel', wheel)
  }, [])

  const allowed = human && connection === 'live'
  return <div ref={sizing} className="saas-live-browser saas-stream" data-stale={connection !== 'live'}>
    {connection !== 'live' && <p role="status" className="saas-frame-notice">{t(connection === 'lost' ? 'frameLost' : 'frameLoading')}</p>}
    {error && <p role="alert" className="saas-stream-error">{error}</p>}
    <canvas ref={canvas} width={INITIAL_VIEWPORT.width} height={INITIAL_VIEWPORT.height} role="img" aria-label={t('live')}
      data-interactive={allowed} aria-disabled={!allowed} onClick={event => {
        if (!allowed || event.button !== 0) return
        const coords = point(event.clientX, event.clientY, event.currentTarget)
        if (coords) send({ kind: 'click', ...coords })
        if (keyboard) editor.current?.focus({ preventScroll: true })
      }} />
    {keyboard && <textarea ref={editor} className="saas-stream-input" aria-label={t('loginKeyboard')} tabIndex={allowed ? 0 : -1}
      onChange={event => {
        if (composing.current) return
        if (event.target.value) send({ kind: 'text', text: event.target.value.slice(0, 1000) })
        event.target.value = ''
      }} onCompositionStart={() => { composing.current = true }}
      onCompositionEnd={event => {
        composing.current = false
        if (event.currentTarget.value) send({ kind: 'text', text: event.currentTarget.value.slice(0, 1000) })
        event.currentTarget.value = ''
      }} onKeyDown={event => {
        if (!allowed || event.nativeEvent.isComposing || composing.current || event.key === 'Escape' || event.key === 'Tab' && event.shiftKey) return
        if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'a') {
          event.preventDefault(); send({ kind: 'key', key: 'ControlOrMeta+A' }); return
        }
        const key = keys.find(candidate => candidate === event.key)
        if (key) { event.preventDefault(); send({ kind: 'key', key }) }
      }} />}
  </div>
}
