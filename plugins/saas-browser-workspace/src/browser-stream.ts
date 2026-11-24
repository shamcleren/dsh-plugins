import type { ServerResponse } from 'node:http'
import type { CDPSession, Page } from 'playwright'
import { FRAME_HEADER_BYTES, INITIAL_VIEWPORT, LIVE_TYPE, MAX_FRAME_BYTES } from './live-protocol.js'

const INTERVAL = 40
const KEEPALIVE = 1500
const MAX_VIEWERS = 3

/** The active page produces frames only while the owner has a viewer. */
export class BrowserStream {
  private viewers = new Set<ServerResponse>()
  private source: { page: Page; cdp: CDPSession } | undefined
  private last: Buffer | undefined
  private interval: ReturnType<typeof setInterval> | undefined
  private timer: ReturnType<typeof setTimeout> | undefined
  private next: Buffer | undefined
  private sentAt = 0
  private active: CDPSession | undefined
  private transition = Promise.resolve()
  private disposed = false
  private validSince = 0
  epoch = 1

  setPage(page?: Page, cdp?: CDPSession): void {
    this.source = page && cdp ? { page, cdp } : undefined
    this.invalidate()
    this.reconcile()
  }

  invalidate(): void {
    this.epoch++
    this.validSince = Date.now() / 1000
    this.last = undefined
    this.next = undefined
    clearTimeout(this.timer); this.timer = undefined
    this.broadcast(this.header())
  }

  connect(response: ServerResponse): void {
    if (!this.source || this.disposed || this.viewers.size >= MAX_VIEWERS) {
      response.writeHead(this.viewers.size >= MAX_VIEWERS ? 429 : 404).end()
      return
    }
    response.writeHead(200, {
      'content-type': LIVE_TYPE, 'cache-control': 'no-store, no-transform',
      'x-content-type-options': 'nosniff', 'x-accel-buffering': 'no',
    })
    response.flushHeaders()
    this.viewers.add(response)
    response.once('close', () => {
      this.viewers.delete(response)
      if (!this.viewers.size) {
        clearInterval(this.interval); this.interval = undefined
        clearTimeout(this.timer); this.timer = undefined
        this.last = undefined; this.next = undefined
        this.reconcile()
      }
    })
    response.on('drain', () => this.write(response, this.last ?? this.header()))
    this.write(response, this.last ?? this.header())
    this.interval ??= setInterval(() => this.broadcast(this.header()), KEEPALIVE)
    this.reconcile()
  }

  private header(length = 0): Buffer {
    const dimensions = this.source?.page.viewportSize() ?? INITIAL_VIEWPORT
    const header = Buffer.allocUnsafe(FRAME_HEADER_BYTES)
    header.writeUInt32BE(length, 0)
    header.writeUInt32BE(dimensions.width, 4)
    header.writeUInt32BE(dimensions.height, 8)
    header.writeUInt32BE(this.epoch, 12)
    return header
  }

  private write(response: ServerResponse, packet: Buffer): void {
    if (!response.destroyed && !response.writableEnded && !response.writableNeedDrain) response.write(packet)
  }

  private broadcast(packet: Buffer): void {
    for (const response of this.viewers) this.write(response, packet)
  }

  private readonly frame = (event: { data: string; sessionId: number; metadata: { deviceWidth: number; deviceHeight: number; timestamp?: number } }) => {
    const source = this.source
    const active = this.active
    if (active) void active.send('Page.screencastFrameAck', { sessionId: event.sessionId }).catch(() => {})
    if (!source || active !== source.cdp || !this.viewers.size || (event.metadata.timestamp ?? Infinity) < this.validSince) return
    const viewport = source.page.viewportSize()
    if (viewport && (Math.abs(event.metadata.deviceWidth - viewport.width) > 1 || Math.abs(event.metadata.deviceHeight - viewport.height) > 1)) return
    if (event.data.length > Math.ceil(MAX_FRAME_BYTES / 3) * 4) return
    const jpeg = Buffer.from(event.data, 'base64')
    this.next = Buffer.concat([this.header(jpeg.length), jpeg])
    if (!this.timer) {
      this.timer = setTimeout(() => {
        this.timer = undefined
        if (!this.next) return
        this.last = this.next; this.next = undefined
        this.sentAt = performance.now()
        this.broadcast(this.last)
      }, Math.max(0, INTERVAL - (performance.now() - this.sentAt)))
    }
  }

  private reconcile(): void {
    this.transition = this.transition.then(async () => {
      const wanted = !this.disposed && this.viewers.size ? this.source?.cdp : undefined
      if (this.active === wanted) return
      if (this.active) {
        const previous = this.active
        previous.off('Page.screencastFrame', this.frame)
        this.active = undefined
        await previous.send('Page.stopScreencast').catch(() => {})
      }
      if (!wanted || this.disposed || !this.viewers.size || this.source?.cdp !== wanted) return
      this.active = wanted
      wanted.on('Page.screencastFrame', this.frame)
      try {
        await wanted.send('Page.startScreencast', { format: 'jpeg', quality: 78, maxWidth: 1600, maxHeight: 1200 })
      } catch {
        wanted.off('Page.screencastFrame', this.frame)
        this.active = undefined
        for (const viewer of this.viewers) viewer.end()
      }
    })
  }

  async close(): Promise<void> {
    this.disposed = true
    for (const viewer of this.viewers) viewer.end()
    this.viewers.clear()
    clearInterval(this.interval)
    clearTimeout(this.timer)
    this.last = this.next = undefined
    this.reconcile()
    await this.transition
  }
}
