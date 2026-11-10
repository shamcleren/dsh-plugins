import { constants } from 'node:fs'
import { lstat, open, readFile, rm } from 'node:fs/promises'
import type { FileHandle } from 'node:fs/promises'

/**
 * Exclusive PID lock file. The caller writes its PID after acquiring and removes the file on release.
 * Recovery only replaces a local lock owned by this user whose process is definitively gone.
 */
export async function acquirePidLock(path: string, guardPath: string, locked: () => Error): Promise<FileHandle> {
  try { return await open(path, 'wx', 0o600) }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error }
  // Serialize recovery: two stale readers must never unlink a new owner's lock.
  // A crash during recovery leaves this guard for explicit ownership inspection.
  let guard: FileHandle
  try { guard = await open(guardPath, 'wx', 0o600) }
  catch { throw locked() }
  try {
    await guard.writeFile(String(process.pid) + '\n')
    let stale: FileHandle
    try { stale = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK) }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return await open(path, 'wx', 0o600)
      throw locked()
    }
    try {
      const stat = await stale.stat()
      if (!stat.isFile() || stat.size > 16 || !process.getuid || stat.uid !== process.getuid()) throw locked()
      const owner = await stale.readFile('utf8')
      if (!/^[1-9]\d*\n$/u.test(owner)) throw locked()
      const pid = Number(owner.trim())
      if (!Number.isSafeInteger(pid) || pid > 2147483647) throw locked()
      let gone = false
      try { process.kill(pid, 0) }
      catch (error) { gone = (error as NodeJS.ErrnoException).code === 'ESRCH' }
      if (!gone) throw locked()
      const current = await lstat(path)
      if (current.isSymbolicLink() || current.dev !== stat.dev || current.ino !== stat.ino || await readFile(path, 'utf8') !== owner) throw locked()
      await rm(path)
      try { return await open(path, 'wx', 0o600) }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw locked()
        throw error
      }
    } finally { await stale.close() }
  } finally { await guard.close(); await rm(guardPath) }
}
