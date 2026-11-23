/** Stable digest of executable plugin sources and their build/dependency contracts. */
import { createHash } from 'node:crypto'
import { lstat, mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

/** Retain the exact build lock without forcing unchanged plugins to be repacked. */
export async function snapshotReleaseLock(repo) {
  const bytes = await readFile(join(repo, 'pnpm-lock.yaml'))
  if (bytes.length > 8 * 1024 * 1024) throw new Error('Release lock is too large')
  const digest = createHash('sha256').update(bytes).digest('hex')
  const relative = 'artifacts/locks/' + digest + '.yaml'
  for (const part of ['artifacts', 'artifacts/locks']) {
    try { await mkdir(join(repo, part)) } catch (error) { if (error.code !== 'EEXIST') throw error }
    const info = await lstat(join(repo, part))
    if (info.isSymbolicLink() || !info.isDirectory()) throw new Error('Invalid release lock directory')
  }
  try { await writeFile(join(repo, relative), bytes, { flag: 'wx' }) }
  catch (error) { if (error.code !== 'EEXIST') throw error }
  await readReleaseLock(repo, relative)
  return relative
}

export async function readReleaseLock(repo, relative) {
  if (!/^artifacts\/locks\/[a-f0-9]{64}\.yaml$/.test(relative)) throw new Error('Invalid release lock path')
  for (const part of ['artifacts', 'artifacts/locks', relative]) {
    const info = await lstat(join(repo, part))
    if (info.isSymbolicLink() || (part === relative ? !info.isFile() || info.size > 8 * 1024 * 1024 : !info.isDirectory())) throw new Error('Invalid release lock file')
  }
  const bytes = await readFile(join(repo, relative))
  if (createHash('sha256').update(bytes).digest('hex') !== relative.slice(16, -5)) throw new Error('Release lock digest mismatch')
  return bytes
}

export async function pluginSourceDigest(directory, repo, sourceLock) {
  const hash = createHash('sha256')
  const excluded = new Set(['node_modules', 'lib', 'dist', '.cache', '.git', 'coverage', 'tests', 'docs', 'standalone'])
  async function visit(path, relative) {
    const info = await lstat(path)
    if (info.isSymbolicLink()) throw new Error('Release input must not be a symlink: ' + relative)
    if (info.isDirectory()) {
      for (const name of (await readdir(path)).sort()) if (!excluded.has(name) && !(relative === '' && name === 'client')) await visit(join(path, name), relative + '/' + name)
    } else if (info.isFile() && (!/\.(?:md|tgz|tsbuildinfo)$/i.test(relative) || relative.startsWith('/skills/'))) hash.update(relative).update('\0').update(await readFile(path)).update('\0')
  }
  await visit(directory, '')
  for (const name of ['tsconfig.base.json', 'pnpm-lock.yaml']) hash.update(name).update(name === 'pnpm-lock.yaml' && sourceLock ? await readReleaseLock(repo, sourceLock) : await readFile(join(repo, name)))
  return hash.digest('hex')
}
