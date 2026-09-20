import { lstat, mkdir, mkdtemp, open, rename, rm, unlink } from 'node:fs/promises'
import { join } from 'node:path'

async function requireAbsent(path) {
  try { await lstat(path) } catch (error) { if (error.code === 'ENOENT') return; throw error }
  throw new Error('Application already exists: ' + path + '. Move it aside or choose another installation directory before rebuilding.')
}

/** Publish one stable app name after validation; never replace an existing output. */
export async function buildAppOutput(directory, build) {
  await mkdir(directory, { recursive: true })
  const stat = await lstat(directory)
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('App output directory must be a real directory')
  const output = join(directory, 'DeepSeek Harness.app')
  const lockPath = join(directory, '.app-build.lock')
  let lock
  try { lock = await open(lockPath, 'wx', 0o600) } catch (error) {
    if (error.code === 'EEXIST') throw new Error('Another app build holds .app-build.lock; do not remove it while that process runs')
    throw error
  }
  let staging
  try {
    await lock.writeFile(String(process.pid) + '\n')
    await requireAbsent(output)
    staging = await mkdtemp(join(directory, '.build-'))
    const app = join(staging, 'DeepSeek Harness.app')
    await build(app, output)
    await requireAbsent(output)
    await rename(app, output)
    return output
  } finally {
    try { if (staging !== undefined) await rm(staging, { recursive: true, force: true }) }
    finally { await lock.close(); await unlink(lockPath) }
  }
}
