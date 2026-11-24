import { FRAME_HEADER_BYTES, LIVE_PATH, LIVE_TYPE, MAX_FRAME_BYTES, type LiveFrame, type LiveSurface } from '../live-protocol.js'

export async function readLiveStream(sessionId: string, signal: AbortSignal, receive: (packet: LiveSurface | LiveFrame) => void): Promise<void> {
  const response = await fetch(LIVE_PATH + '?' + new URLSearchParams({ sessionId }), { credentials: 'same-origin', cache: 'no-store', signal })
  if (!response.ok || response.headers.get('content-type') !== LIVE_TYPE || !response.body) throw new Error('frame-unavailable')

  await readLivePackets(response.body, receive)
}

export async function readLivePackets(body: ReadableStream<Uint8Array<ArrayBuffer>>, receive: (packet: LiveSurface | LiveFrame) => void): Promise<void> {
  const reader = body.getReader()
  const header = new Uint8Array(FRAME_HEADER_BYTES), view = new DataView(header.buffer)
  let headerUsed = 0, jpegUsed = 0
  let jpeg: Uint8Array<ArrayBuffer> | undefined
  let surface: LiveSurface
  try {
    while (true) {
      const { value, done } = await reader.read()
      if (done) return
      for (let offset = 0; offset < value.length;) {
        if (!jpeg) {
          const copied = Math.min(header.length - headerUsed, value.length - offset)
          header.set(value.subarray(offset, offset + copied), headerUsed)
          headerUsed += copied; offset += copied
          if (headerUsed < header.length) continue
          const size = view.getUint32(0)
          surface = { width: view.getUint32(4), height: view.getUint32(8), epoch: view.getUint32(12) }
          if (size > MAX_FRAME_BYTES || surface.width < 1 || surface.width > 1600 || surface.height < 1 || surface.height > 1200 || !surface.epoch) {
            throw new Error('invalid-live-frame')
          }
          headerUsed = 0
          if (!size) { receive(surface); continue }
          jpeg = new Uint8Array(size); jpegUsed = 0
        }
        const copied = Math.min(jpeg.length - jpegUsed, value.length - offset)
        jpeg.set(value.subarray(offset, offset + copied), jpegUsed)
        jpegUsed += copied; offset += copied
        if (jpegUsed === jpeg.length) {
          receive({ ...surface!, jpeg })
          jpeg = undefined
        }
      }
    }
  } finally {
    await reader.cancel().catch(() => {})
    reader.releaseLock()
  }
}
