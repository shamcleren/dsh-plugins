/** Resolve the actual shipped Host entry without consulting a user profile. */
import { access, readFile } from 'node:fs/promises'
import { constants } from 'node:fs'
import { join, resolve } from 'node:path'

async function executable(path) {
  try { await access(path, constants.X_OK); return true }
  catch (error) { if (error.code === 'ENOENT' || error.code === 'EACCES') return false; throw error }
}

export async function smokeTarget({ repo, desktopApp, runtimeOverride, node = process.execPath }) {
  const runtime = resolve(runtimeOverride ?? join(repo, 'runtime'))
  if (!desktopApp) return { kind: 'web', runtime, node, profileName: 'web' }
  const resources = join(desktopApp, 'Contents/Resources')
  if (await executable(join(desktopApp, 'Contents/MacOS/DeepSeekHarness'))) {
    const bundledRuntime = join(resources, 'runtime'), bundledNode = join(resources, 'node/bin/node')
    if (runtimeOverride && resolve(runtimeOverride) !== bundledRuntime) throw new Error('Native App smoke must use its bundled runtime; omit the runtime override')
    if (!await executable(bundledNode)) throw new Error('Native App has no executable bundled Node.js')
    const manifest = JSON.parse(await readFile(join(bundledRuntime, 'node_modules/@deepseek-ai/dsh/package.json'), 'utf8'))
    if (manifest.name !== '@deepseek-ai/dsh' || typeof manifest.version !== 'string') throw new Error('Native App has no valid official DSH runtime')
    return { kind: 'native', runtime: bundledRuntime, node: bundledNode, profileName: 'web', version: manifest.version }
  }
  const electron = join(desktopApp, 'Contents/MacOS/DeepSeek Harness')
  if (!await executable(electron)) throw new Error('Unsupported Desktop App layout: no native or Electron entry')
  return { kind: 'electron', runtime, node, profileName: 'desktop', electron }
}
