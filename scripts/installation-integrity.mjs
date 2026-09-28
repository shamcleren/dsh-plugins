/** Fingerprint installer-owned trees without following links into user directories. */
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { lstat, readlink, readdir } from 'node:fs/promises'
import { join } from 'node:path'

export async function treeDigest(root) {
  const hash = createHash('sha256')
  async function visit(path, relative) {
    const info = await lstat(path)
    hash.update(JSON.stringify([relative, info.mode & 0o111,
      info.isSymbolicLink() ? 'link' : info.isDirectory() ? 'directory' : 'file']))
    if (info.isSymbolicLink()) hash.update(await readlink(path))
    else if (info.isDirectory()) {
      for (const name of (await readdir(path)).sort()) await visit(join(path, name), relative + '/' + name)
    } else if (info.isFile()) {
      const content = createHash('sha256')
      for await (const chunk of createReadStream(path)) content.update(chunk)
      hash.update(content.digest())
    } else throw new Error('Unsupported installer-owned file: ' + path)
  }
  try { await visit(root, ''); return hash.digest('hex') }
  catch (error) { if (error.code === 'ENOENT') return null; throw error }
}

export async function installationIntegrity(root, app) {
  return {
    runtime: await treeDigest(join(root, 'runtime')),
    node: await treeDigest(join(root, 'node')),
    launchers: await launcherIntegrity(root),
    app: app ? await treeDigest(join(root, app)) : null,
  }
}

export async function launcherIntegrity(root) {
  const result = {}
  for (const name of ['dsh', 'dsh.mjs', 'process.mjs', 'dhp']) result[name] = await treeDigest(join(root, 'bin', name))
  return result
}
