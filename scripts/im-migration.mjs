/** IM package replacement keeps legacy config scopes and data paths, with explicit connection intent. */
import { lstat, readFile, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { join } from 'node:path'

const platforms = [{ id: 'wechat', package: '@shamcleren/dsh-wechat' }, { id: 'wecom-aibot', package: '@shamcleren/dsh-wecom-aibot' }]
function yamlFor(runtime) { return createRequire(join(runtime, 'package.json'))('yaml') }
async function document(profile, yaml) {
  const path = join(profile, 'cordis.patch.yml')
  let text = '[]\n'
  try { const info = await lstat(path); if (!info.isFile() || info.isSymbolicLink()) throw new Error('IM migration requires a regular profile patch'); text = await readFile(path, 'utf8') }
  catch (error) { if (error.code !== 'ENOENT') throw error }
  const parsed = yaml.parseDocument(text)
  if (parsed.errors.length || !yaml.isSeq(parsed.contents)) throw new Error('IM migration requires a valid sequence profile patch')
  return { path, parsed }
}
function rows(parsed, yaml, id) { return parsed.contents.items.filter(row => yaml.isMap(row) && row.get('id') === id) }

/** Call only on the owned staged profile, after its original fingerprint was recorded. */
export async function captureLegacyIm(profile, manifest, runtime) {
  const installed = platforms.filter(platform => Object.hasOwn(manifest?.dependencies ?? {}, platform.package))
  if (!installed.length) return []
  const yaml = yamlFor(runtime), { parsed } = await document(profile, yaml)
  return installed.map(platform => {
    const matches = rows(parsed, yaml, platform.id)
    if (matches.length > 1) throw new Error('Ambiguous legacy IM configuration: ' + platform.id)
    const row = matches[0]?.clone() ?? parsed.createNode({ id: platform.id })
    const config = row.get('config')
    if (config !== undefined && !yaml.isMap(config)) throw new Error('Invalid legacy IM configuration: ' + platform.id)
    const disabled = row.get('disabled')
    if (disabled !== undefined && typeof disabled !== 'boolean') throw new Error('IM migration cannot infer a dynamic enable condition: ' + platform.id)
    const connection = config?.get('connectionEnabled')
    if (connection !== undefined && typeof connection !== 'boolean') throw new Error('Invalid IM connection state: ' + platform.id)
    // The old `enabled` field was retired and ignored. Never reinterpret it.
    const enabled = manifest.dsh?.profile?.bundles?.includes(platform.package) === true && disabled !== true && connection !== false
    return { id: platform.id, row, enabled }
  })
}

export async function applyLegacyIm(profile, captured, runtime) {
  if (!captured.length) return
  const yaml = yamlFor(runtime), { path, parsed } = await document(profile, yaml)
  for (const legacy of captured) {
    const existing = rows(parsed, yaml, legacy.id)
    if (existing.length > 1) throw new Error('Ambiguous IM replacement configuration: ' + legacy.id)
    const row = legacy.row.clone()
    row.delete('name'); row.delete('disabled')
    if (row.get('config') === undefined) row.set('config', parsed.createNode({}))
    row.get('config').set('connectionEnabled', legacy.enabled)
    if (existing.length) parsed.contents.items[parsed.contents.items.indexOf(existing[0])] = row
    else parsed.contents.add(row)
  }
  parsed.contents.flow = false
  await writeFile(path, parsed.toString(), { mode: 0o600 })
}
