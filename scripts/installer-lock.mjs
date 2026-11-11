/** PID locks with kernel-owned serialization for safe recovery after process exit. */
import { createHash, randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { link, lstat, open, realpath, unlink } from 'node:fs/promises'
import { createConnection, createServer } from 'node:net'
import { basename, dirname, join } from 'node:path'

const protocol = 'dhp-installer-lease/v1 '
const identity = (a, b) => a.dev === b.dev && a.ino === b.ino
function processState(pid) {
  try { process.kill(pid, 0); return 'alive' }
  catch (error) { return error.code === 'ESRCH' ? 'dead' : 'unknown' }
}

async function snapshot(path) {
  let fd
  try {
    const entry = await lstat(path)
    if (!entry.isFile() || entry.isSymbolicLink() || entry.size > 64 || (entry.mode & 0o077) !== 0 || (process.getuid && entry.uid !== process.getuid())) throw new Error('Unverified installer lock')
    fd = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
    const info = await fd.stat(), text = await fd.readFile('utf8')
    if (!identity(info, entry) || !/^[1-9]\d*\n?$/.test(text)) throw new Error('Unverified installer lock')
    const pid = Number(text.trim())
    if (!Number.isSafeInteger(pid) || pid > 0x7fffffff) throw new Error('Unverified installer lock')
    return { info, text, pid }
  } catch (error) { if (error.code === 'ENOENT') return undefined; throw error }
  finally { await fd?.close() }
}

/** Read-only diagnostics never remove locks or reveal their contents. */
export async function inspectInstallerLock(path, { probe = processState } = {}) {
  try { const current = await snapshot(path); return current ? { status: probe(current.pid), pid: current.pid } : { status: 'absent' } }
  catch { return { status: 'unknown' } }
}

function identifyLease(port) {
  return new Promise(resolve => {
    let text = '', settled = false
    const socket = createConnection({ host: '127.0.0.1', port })
    const finish = value => { if (settled) return; settled = true; socket.destroy(); resolve(value) }
    socket.setTimeout(500, () => finish(undefined))
    socket.on('error', () => finish(undefined))
    socket.on('data', chunk => {
      text += chunk.toString('utf8')
      if (text.length > 128) return finish(undefined)
      if (text.includes('\n')) finish(/^dhp-installer-lease\/v1 ([a-f0-9]{64})\n$/.exec(text)?.[1])
    })
    socket.on('end', () => finish(undefined))
    socket.on('close', () => finish(undefined))
  })
}

/** The OS releases this lease on exit, including SIGKILL. No stale recovery mutex. */
async function serialize(path, busy) {
  const canonical = join(await realpath(dirname(path)), basename(path))
  const hash = createHash('sha256').update(canonical).digest(), key = hash.toString('hex')
  // Avoid the default ephemeral port ranges used by macOS/Linux. Colliding DHP
  // leases identify themselves so unrelated installations can use another slot.
  for (let attempt = 0; attempt < 16; attempt++) {
    const port = 10000 + (hash.readUInt16BE(0) + attempt * 997) % 15000
    const sockets = new Set()
    const server = createServer(socket => {
      sockets.add(socket)
      socket.on('error', () => {})
      socket.on('close', () => sockets.delete(socket))
      socket.setTimeout(1000, () => socket.destroy())
      socket.end(protocol + key + '\n')
    })
    server.maxConnections = 16
    try {
      await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve) })
      server.unref()
      return async () => { for (const socket of sockets) socket.destroy(); await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())) }
    } catch (error) {
      if (error.code !== 'EADDRINUSE') throw error
      const occupied = await identifyLease(port)
      if (!occupied) throw new Error('Installer lock guard is unavailable on 127.0.0.1:' + port + '; no lock was removed')
      if (occupied === key) throw new Error(busy)
    }
  }
  throw new Error(busy)
}

export async function acquireInstallerLock(path, { busy = 'Another installer holds ' + basename(path), probe = processState, log = () => {} } = {}) {
  const releaseLease = await serialize(path, busy)
  const candidate = path + '.' + randomUUID() + '.pending'
  let fd, published = false, owned
  try {
    let current
    try { current = await snapshot(path) }
    catch { throw new Error('Cannot verify ' + basename(path) + '; it was left unchanged. Inspect its owner before retrying.') }
    if (current) {
      if (probe(current.pid) !== 'dead') throw new Error(busy + ' (PID ' + current.pid + '); do not remove it while that process runs')
      const backup = path + '.stale-' + current.pid + '-' + randomUUID()
      await link(path, backup)
      const latest = await snapshot(path)
      if (!latest || !identity(current.info, latest.info) || current.text !== latest.text) { await unlink(backup); throw new Error('Installer lock changed; retry without removing it') }
      await unlink(path)
      log('Recovered stale ' + basename(path) + ' from exited PID ' + current.pid + '; retained ' + basename(backup))
    }
    // Publish a fully written PID file; a crash before publication cannot leave
    // an empty canonical lock whose ownership cannot be verified.
    fd = await open(candidate, 'wx', 0o600)
    await fd.writeFile(String(process.pid) + '\n')
    await fd.sync()
    owned = await fd.stat()
    await link(candidate, path); published = true
    await unlink(candidate)
  } catch (error) {
    try {
      if (published) {
        const current = await snapshot(path)
        if (current && identity(current.info, owned) && current.text === String(process.pid) + '\n') await unlink(path)
      }
    } finally {
      try { await fd?.close(); if (fd) await unlink(candidate).catch(error => { if (error.code !== 'ENOENT') throw error }) }
      finally { await releaseLease() }
    }
    throw error
  }
  let released = false
  return async () => {
    if (released) return
    released = true
    try {
      const current = await snapshot(path)
      if (published && current && identity(current.info, owned) && current.text === String(process.pid) + '\n') await unlink(path)
      else if (current) throw new Error('Installer lock ownership changed; it was left unchanged')
    } finally { try { await fd.close() } finally { await releaseLease() } }
  }
}
