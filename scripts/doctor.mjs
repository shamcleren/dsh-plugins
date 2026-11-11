/** Read-only installation diagnostics and a preview of the pinned upgrade. */
import { createServer } from 'node:net'
import { lstat, readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { releaseInfo } from './bootstrap.mjs'
import { inspectInstallerLock } from './installer-lock.mjs'
import { defaultDirectory, listOwnedProcesses, readNativeApp, repositoryRoot } from './installation.mjs'
import { readInstallationState } from './update-installation.mjs'
import { homeProfileUpdates, profilePeerIssues } from './home-compatibility.mjs'
import { installedRetirements } from './retired-plugins.mjs'

async function optional(path) { try { return await lstat(path) } catch (error) { if (error.code !== 'ENOENT') throw error } }
export async function portAvailable(port) {
  const server = createServer()
  return new Promise((resolve, reject) => {
    server.once('error', error => error.code === 'EADDRINUSE' ? resolve(false) : reject(error))
    server.listen(port, '127.0.0.1', () => server.close(error => error ? reject(error) : resolve(true)))
  })
}

export async function doctor({ directory = defaultDirectory(), repo = repositoryRoot, log = console.log, inspect, probe = portAvailable } = {}) {
  const checks = []
  const add = (name, ok, detail) => { checks.push({ name, ok, detail }); log((ok ? 'OK ' : 'CHECK ') + name + ': ' + detail) }
  const root = directory
  let state
  try {
    state = await readInstallationState(root)
    if (state.owner !== 'shamcleren/dsh-plugin/bootstrap-v1' || ![1, 2].includes(state.schemaVersion)) throw new Error('Invalid ownership')
  } catch { add('Installation', false, 'No valid installation record; run make init with this DIR.'); return { ok: false, checks } }
  const home = state.schemaVersion === 1 ? join(root, 'home') : state.dshHome
  if (typeof home !== 'string' || !home.startsWith('/')) { add('Data directory', false, 'Invalid installation data directory.'); return { ok: false, checks } }
  add('Installation', state.status === 'ready', root + ' (' + state.status + ')')
  add('Data directory', true, home)
  for (const [label, path] of [['Installer lock', join(root, '.bootstrap.lock')], ['Runtime transaction', join(root, '.update-transaction.json')],
    ['Shared-home lock', join(home, '.dhp-install.lock')], ['Profile transaction', join(home, '.dhp-profile-update.json')]]) {
    const present = await optional(path)
    const lock = present && path.endsWith('.lock') ? await inspectInstallerLock(path) : undefined
    add(label, !present, !present ? 'clear' : lock?.status === 'dead'
      ? 'Present; PID ' + lock.pid + ' has exited. The next dhp update can recover this lock.'
      : lock?.status === 'alive' ? 'Present; PID ' + lock.pid + ' is running. Finish that operation before updating.'
        : lock ? 'Present; ownership is unverified. Inspect the owning operation before updating.'
          : 'Present; finish the owning operation before updating.')
  }
  const running = await listOwnedProcesses(root, inspect ? { inspect } : {})
  add('Processes', running.length === 0, running.length ? 'Exit this installation before updating (PID ' + running.map(p => p.pid).join(', ') + ').' : 'stopped')
  const runtime = join(root, 'runtime'), profile = join(home, 'profiles/web'), release = await releaseInfo(repo)
  let replacements = []
  try {
    replacements = await homeProfileUpdates({ home, repo, release })
    log('Upgrade target: DSH ' + release.dshVersion)
    for (const item of replacements) log('  ' + item.id + ': ' + item.current + ' -> ' + item.target)
    const manifest = JSON.parse(await readFile(join(profile, 'package.json'), 'utf8').catch(error => { if (error.code !== 'ENOENT') throw error; return '{}' }))
    const catalog = JSON.parse(await readFile(join(repo, 'marketplace.json'), 'utf8'))
    const ignored = new Set([...catalog.plugins.filter(p => replacements.some(item => item.id === p.id)).map(p => p.package), ...installedRetirements(manifest).map(p => p.package)])
    const issues = await profilePeerIssues(profile, runtime, ignored, release.dshVersion)
    add('Target plugin declarations', issues.length === 0, issues.length ? issues.join('\n') : 'No declared DSH conflicts; replacement packages are verified during update.')
    for (const name of ['bin/dsh', 'bin/dhp', 'runtime/node_modules/@deepseek-ai/dsh/lib/bin.js']) {
      const info = await optional(join(root, name))
      add(name, !!info?.isFile(), info?.isFile() ? 'present' : 'missing; run make init to repair')
    }
  } catch { add('Runtime/plugin metadata', false, 'Could not complete compatibility checks; run make init to prepare or repair the locked runtime.') }
  const credentials = await optional(join(home, '.credentials.yaml'))
  add('Credentials', !credentials || (credentials.isFile() && !credentials.isSymbolicLink() &&
    (process.platform === 'win32' || ((credentials.mode & 0o077) === 0 && credentials.uid === process.getuid()))), credentials ? 'Checked file ownership and permissions; values were not displayed.' : 'No local credential file.')
  const app = state.desktop ? await readNativeApp(root).catch(() => undefined) : undefined
  if (state.desktop) add('macOS App', !!app, app ? 'version ' + app.version : 'missing or invalid; run make init to repair')
  if (!running.length) {
    const port = app?.port ?? 3080
    add('Port ' + port, await probe(port), 'Availability checked on 127.0.0.1.')
  }
  const backupInfo = await optional(join(home, '.dhp-backups'))
  if (backupInfo && (!backupInfo.isDirectory() || backupInfo.isSymbolicLink())) add('Backups', false, 'Expected a real directory.')
  else {
    const backups = backupInfo ? await readdir(join(home, '.dhp-backups')) : []
    add('Backups', true, backups.length + ' entries retained in ' + join(home, '.dhp-backups'))
  }
  log('Preview only. Full integrity, credential-format validation and staged plugin checks run during update.')
  return { ok: checks.every(check => check.ok), checks, replacements }
}
