/** Stable digest of executable plugin sources and their build/dependency contracts. */
import { createHash } from 'node:crypto'
import { lstat, readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'

export async function pluginSourceDigest(directory, repo) {
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
  for (const name of ['tsconfig.base.json', 'pnpm-lock.yaml']) hash.update(name).update(await readFile(join(repo, name)))
  return hash.digest('hex')
}
