/** Serialize this repository's installers and plugin writers across shared DSH homes. */
import { lstat, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { acquireInstallerLock } from './installer-lock.mjs'
export async function lockDshHome(home, { log } = {}) {
  await mkdir(home, { recursive: true, mode: 0o700 })
  const info = await lstat(home)
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Expected a real DSH home directory')
  const path = join(home, '.dhp-install.lock')
  return acquireInstallerLock(path, { busy: 'Another installer or plugin command is using this DSH home (.dhp-install.lock)', log })
}
