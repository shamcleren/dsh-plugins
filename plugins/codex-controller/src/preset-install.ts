/** Install the Codex session preset into the public user-preset root without replacing an unknown directory. */
import { createHash } from 'node:crypto'
import { lstat, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { PresetRoot } from '@deepseek-ai/dsh-agent-presets'

export const CODEX_PRESET = 'dsh-codex'
const files = ['agent.cordis.yml', 'preset.yml'] as const
const owner = 'shamcleren/codex-controller-preset-v1'
const preparations = new Map<string, Promise<void>>()

/** Remove only the preset this plugin installed, so Codex is a model and not a second mode. */
export function retireCodexPreset(roots: readonly PresetRoot[]): Promise<void> {
  const key = 'retire:' + JSON.stringify(roots)
  const pending = preparations.get(key)
  if (pending) return pending
  const operation = removeOwned(roots).finally(() => { preparations.delete(key) })
  preparations.set(key, operation)
  return operation
}

export function ensureCodexPreset(roots: readonly PresetRoot[]): Promise<void> {
  const key = JSON.stringify(roots)
  const pending = preparations.get(key)
  if (pending) return pending
  const operation = install(roots).finally(() => { preparations.delete(key) })
  preparations.set(key, operation)
  return operation
}

async function removeOwned(roots: readonly PresetRoot[]): Promise<void> {
  const root = roots.find(item => item.trust === 'user')?.path
  if (!root || !isAbsolute(root)) return
  const destination = join(root, CODEX_PRESET)
  let marker: { owner?: string }
  try {
    marker = JSON.parse(await readFile(join(destination, '.codex-controller-owner.json'), 'utf8')) as { owner?: string }
  } catch {
    return
  }
  if (marker.owner !== owner) return
  await rm(destination, { recursive: true })
}

async function install(roots: readonly PresetRoot[]): Promise<void> {
  const root = roots.find(item => item.trust === 'user')?.path
  if (!root || !isAbsolute(root)) throw new Error('codex-preset-root-unavailable')
  const source = fileURLToPath(new URL('../agent-presets/dsh-codex/', import.meta.url))
  const expected = await Promise.all(files.map(file => readFile(join(source, file))))
  const digest = createHash('sha256').update(Buffer.concat(expected)).digest('hex')
  const destination = join(root, CODEX_PRESET)
  let exists = true
  try {
    const stat = await lstat(destination)
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('codex-preset-conflict')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') exists = false
    else throw error
  }
  if (exists) {
    const marker = JSON.parse(await readFile(join(destination, '.codex-controller-owner.json'), 'utf8')) as { owner?: string; digest?: string }
    if (marker.owner !== owner) throw new Error('codex-preset-conflict')
    if (marker.digest === digest) return
  }
  await mkdir(root, { recursive: true, mode: 0o700 })
  await mkdir(destination, { recursive: true, mode: 0o700 })
  for (const [index, file] of files.entries()) await writeFile(join(destination, file), expected[index]!, { mode: 0o600 })
  await writeFile(join(destination, '.codex-controller-owner.json'), JSON.stringify({ owner, digest }), { mode: 0o600 })
}
