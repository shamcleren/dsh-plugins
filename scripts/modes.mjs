/** Inspect reviewed workbench compositions without changing profiles or credentials. */
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { repositoryRoot, readInstallation } from './installation.mjs'

export async function readModes(repo = repositoryRoot) {
  const document = JSON.parse(await readFile(join(repo, 'docs/modes.json'), 'utf8'))
  const catalog = JSON.parse(await readFile(join(repo, 'marketplace.json'), 'utf8'))
  if (document.schemaVersion !== 1 || !Array.isArray(document.modes) || document.modes.length > 50) throw new Error('Invalid workbench mode catalog')
  const ids = new Set()
  for (const mode of document.modes) {
    if (!/^[a-z][a-z0-9-]{1,63}$/.test(mode.id) || ids.has(mode.id) || typeof mode.name !== 'string' || typeof mode.description !== 'string' ||
        typeof mode.prompt !== 'string' || !Array.isArray(mode.setup) || !mode.setup.every(s => typeof s === 'string') ||
        !Array.isArray(mode.plugins) || !mode.plugins.every(id => catalog.plugins.some(p => p.id === id))) throw new Error('Invalid workbench mode')
    ids.add(mode.id)
  }
  return document.modes
}

export async function describeModes({ action, id, directory, repo = repositoryRoot, log = console.log }) {
  const modes = await readModes(repo)
  if (action === 'list' && id === undefined) { for (const mode of modes) log(mode.id + ' — ' + mode.name + ': ' + mode.description); return }
  if (action !== 'plan' || !id) throw new Error('Usage: dhp mode list | dhp mode plan <id>')
  const mode = modes.find(mode => mode.id === id)
  if (!mode) throw new Error('Unknown workbench mode')
  let installed = {}
  try {
    const installation = await readInstallation(directory, repo)
    installed = JSON.parse(await readFile(join(installation.profile, 'package.json'), 'utf8')).dependencies ?? {}
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
    log('Installation is not initialized; run make init before preparing plugins.')
  }
  const catalog = JSON.parse(await readFile(join(repo, 'marketplace.json'), 'utf8'))
  log(mode.name + '\n' + mode.description)
  for (const id of mode.plugins) {
    const entry = catalog.plugins.find(p => p.id === id)
    log('  ' + id + ': ' + (installed[entry.package] ? 'installed' : 'prepare with dhp plugin install ' + id))
  }
  for (const step of mode.setup) log('  ' + step)
  log('任务示例：\n' + mode.prompt)
  log('Plan only: this command does not activate a preset, configure an account or create a schedule.')
}
