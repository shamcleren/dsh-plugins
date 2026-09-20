import { lstat, mkdir, readFile, writeFile } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'
import type { PresetRoot } from '@deepseek-ai/dsh-agent-presets'

export const SECURITY_PRESET = 'dsh-security-audit'
const source = fileURLToPath(new URL('../agent-presets/dsh-security-audit/', import.meta.url))
const files = ['agent.cordis.yml', 'preset.yml'] as const
const owner = 'shamcleren/security-scan-preset-v1'
/** Installs only into the public external-preset root; never changes the selected default. */
const preparations = new Map<string, Promise<void>>()
export function ensureSecurityPreset(roots: readonly PresetRoot[]): Promise<void> {
  const key = JSON.stringify(roots)
  const pending = preparations.get(key)
  if (pending) return pending
  const operation = install(roots).finally(() => { preparations.delete(key) })
  preparations.set(key, operation)
  return operation
}
async function install(roots: readonly PresetRoot[]): Promise<void> {
  const root = roots.find(root => root.trust === 'user')?.path
  if (!root || !isAbsolute(root)) throw new Error('security-preset-root-unavailable')
  const destination = join(root, SECURITY_PRESET)
  const expected = await Promise.all(files.map(file => readFile(join(source, file))))
  const digest = createHash('sha256').update(Buffer.concat(expected)).digest('hex')
  let exists = true
  try {
    const stat = await lstat(destination)
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('security-preset-conflict')
  } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') exists = false; else throw error }
  if (exists) {
    try {
      const markerPath = join(destination, '.security-scan-owner.json'), stat = await lstat(markerPath)
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 1024) throw new Error('security-preset-conflict')
      const marker = JSON.parse(await readFile(markerPath, 'utf8')) as { owner?: string; digest?: string }
      if (marker.owner !== owner || marker.digest !== digest) throw new Error('security-preset-conflict')
      for (const [index, file] of files.entries()) {
        const stat = await lstat(join(destination, file))
        if (!stat.isFile() || stat.isSymbolicLink() || stat.size !== expected[index]!.length || !(await readFile(join(destination, file))).equals(expected[index]!)) throw new Error('security-preset-conflict')
      }
    } catch { throw new Error('security-preset-conflict') }
    return
  }
  await mkdir(root, { recursive: true, mode: 0o700 })
  if ((await lstat(root)).isSymbolicLink()) throw new Error('security-preset-conflict')
  // Atomic ownership claim; never rename over even an empty pre-existing directory.
  await mkdir(destination, { mode: 0o700 })
  await writeFile(join(destination, '.security-scan-owner.json'), JSON.stringify({ owner, digest }), { flag: 'wx', mode: 0o600 })
  for (const [index, file] of files.entries()) await writeFile(join(destination, file), expected[index]!, { flag: 'wx', mode: 0o600 })
}
