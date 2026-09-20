/** Serialize this repository's installers and plugin writers across shared DSH homes. */
import { lstat, mkdir, open, rm } from 'node:fs/promises'
import { join } from 'node:path'
export async function lockDshHome(home) {
  await mkdir(home, { recursive: true, mode: 0o700 })
  const info = await lstat(home)
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Expected a real DSH home directory')
  const path = join(home, '.dhp-install.lock')
  let fd
  try { fd = await open(path, 'wx', 0o600) }
  catch (error) { if (error.code === 'EEXIST') throw new Error('Another installer or plugin command is using this DSH home (.dhp-install.lock); finish it before retrying'); throw error }
  try { await fd.writeFile(String(process.pid) + '\n') }
  catch (error) { await fd.close(); await rm(path); throw error }
  return async () => { await fd.close(); await rm(path) }
}
