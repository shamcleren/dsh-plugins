/** Verify a startup URL emitted by this child, without exposing its bearer token. */
import { open } from 'node:fs/promises'

export async function waitForWeb({ child, logPath, offset, port, timeoutMs = 30_000, request = fetch }) {
  let failure, exited = child.exitCode != null || child.signalCode != null
  const onError = error => { failure = error }
  const onExit = () => { exited = true }
  child.on('error', onError)
  child.on('exit', onExit)
  const file = await open(logPath, 'r')
  let pending = '', url
  const deadline = Date.now() + timeoutMs
  try {
    while (Date.now() < deadline) {
      if (failure || exited) throw new Error('Web process failed before becoming ready. Log: ' + logPath)
      const buffer = Buffer.alloc(64 * 1024)
      const { bytesRead } = await file.read(buffer, 0, buffer.length, offset)
      offset += bytesRead
      pending += buffer.subarray(0, bytesRead).toString('utf8')
      const lines = pending.split('\n')
      pending = lines.pop().slice(-131072)
      for (const line of lines) {
        if (!line.startsWith('dsh web: ')) continue
        try {
          const candidate = new URL(line.slice(9).trim())
          if (candidate.protocol === 'http:' && candidate.hostname === '127.0.0.1' && candidate.port === String(port) &&
              !candidate.username && !candidate.password && candidate.pathname === '/' && !candidate.hash &&
              [...candidate.searchParams].length === 1 && /^[A-Za-z0-9_-]+$/.test(candidate.searchParams.get('token') ?? '')) url = candidate
        } catch { /* Other child output is not a startup signal. */ }
      }
      if (url) {
        try {
          const response = await request(url, { redirect: 'manual', signal: AbortSignal.timeout(1000) })
          const location = response.headers.get('location')
          const ready = response.status === 200 || ([302, 303, 307, 308].includes(response.status) && location && new URL(location, url).origin === url.origin)
          await response.body?.cancel()
          if (ready && !failure && !exited) return
        } catch { /* Retry only until this child's startup deadline. */ }
      }
      await new Promise(resolve => setTimeout(resolve, 50))
    }
    throw new Error('Web startup timed out. Log: ' + logPath)
  } finally {
    await file.close()
    child.off('error', onError)
    child.off('exit', onExit)
  }
}
