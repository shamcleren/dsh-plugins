/** Short repository-local plugin commands, backed by the official DSH CLI. */
import { execFile } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { lstat, mkdir, open, readFile, readdir, rename, rm, unlink, writeFile } from 'node:fs/promises'
import { dirname, join, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import { defaultDirectory, readInstallation, repositoryRoot } from './installation.mjs'
import { run } from './process.mjs'

const repository = repositoryRoot
const capture = promisify(execFile)
const packagePattern = /^@[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*$/
const digest = bytes => createHash('sha256').update(bytes).digest('hex')

async function optionalFile(path) {
  try {
    const stat = await lstat(path)
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Expected a regular file: ' + path)
    return await readFile(path)
  } catch (error) { if (error.code !== 'ENOENT') throw error }
}

async function atomicWrite(path, bytes) {
  const temporary = path + '.' + randomUUID() + '.next'
  try {
    await writeFile(temporary, bytes, { flag: 'wx', mode: 0o600 })
    await rename(temporary, path)
  } finally { await rm(temporary, { force: true }) }
}


async function readCatalog(repo) {
  const catalog = JSON.parse(await readFile(join(repo, 'marketplace.json'), 'utf8'))
  if (catalog.schemaVersion !== 1 || !Array.isArray(catalog.plugins)) throw new Error('Invalid repository catalog')
  for (const entry of catalog.plugins) {
    if (!entry || typeof entry.package !== 'string' || !packagePattern.test(entry.package)) throw new Error('Invalid catalog package name')
    if (typeof entry.id !== 'string' || !/^[a-z0-9][a-z0-9-]*$/.test(entry.id) ||
        typeof entry.version !== 'string' || !/^\d+\.\d+\.\d+(?:[-+][a-zA-Z0-9.+-]+)?$/.test(entry.version)) throw new Error('Invalid catalog identity/version')
  }
  return catalog.plugins
}

async function catalogEntry(repo, name) {
  const plugins = await readCatalog(repo)
  const id = name === 'marketplace' ? 'trusted-marketplace' : name
  const entries = plugins.filter(entry => entry.id === id || entry.package === id)
  if (entries.length !== 1) throw new Error('Choose a plugin name. Available: ' + plugins.map(entry => entry.id === 'trusted-marketplace' ? 'marketplace' : entry.id).join(', '))
  const entry = entries[0]
  if (!['before-web-app', 'after-web-app'].includes(entry.placement)) throw new Error('Invalid catalog placement')
  return entry
}

function pluginName(entry) {
  return entry.id === 'trusted-marketplace' ? 'marketplace' : entry.id
}

async function installedPackageVersion(profile, packageName) {
  // Resolve pnpm and local-source directory links to the actual version, not a file: specifier.
  const manifest = await optionalFile(join(profile, 'node_modules', packageName, 'package.json'))
  if (!manifest) return
  const value = JSON.parse(manifest)
  if (value.name === packageName && typeof value.version === 'string' && value.version) return value.version
}

async function declaredCatalogEntries(repo, profile) {
  const plugins = await readCatalog(repo)
  const bytes = await optionalFile(join(profile, 'package.json'))
  const dependencies = bytes ? JSON.parse(bytes).dependencies ?? {} : {}
  return plugins.filter(entry => Object.hasOwn(dependencies, entry.package))
}

async function listPlugins(repo, profile, log) {
  const plugins = await readCatalog(repo)
  const bytes = await optionalFile(join(profile, 'package.json'))
  const dependencies = bytes ? JSON.parse(bytes).dependencies ?? {} : {}
  log('本仓库插件（本地版本以当前仓库的发布目录为准）')
  log('PLUGIN             状态        已安装版本 / 本地版本')
  for (const entry of plugins) {
    const declared = Object.hasOwn(dependencies, entry.package)
    const installed = declared ? await installedPackageVersion(profile, entry.package) : undefined
    const status = installed ? '已安装    ' : declared ? '安装不完整' : '未安装    '
    log(pluginName(entry).padEnd(18) + ' ' + status + '  ' + (installed ?? '-') + ' / ' + entry.version)
  }
}

export async function releaseArtifact(repo, entry) {
  const artifact = entry.artifact
  if (!artifact || !/^artifacts\/[^/\\]+\.tgz$/.test(artifact.path) || !/^[a-f0-9]{64}$/.test(artifact.sha256) ||
      !Number.isSafeInteger(artifact.size) || artifact.size <= 0 || artifact.size > 50 * 1024 * 1024) throw new Error('Invalid catalog artifact')
  const path = join(repo, artifact.path)
  const stat = await lstat(path)
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size !== artifact.size) throw new Error('Artifact size or file type mismatch')
  const bytes = await readFile(path)
  if (digest(bytes) !== artifact.sha256) throw new Error('Artifact SHA-256 mismatch')
  const { stdout } = await capture('tar', ['-xOf', path, 'package/package.json'], { maxBuffer: 1024 * 1024 })
  const manifest = JSON.parse(stdout)
  if (manifest.name !== entry.package || manifest.version !== entry.version || typeof manifest.dsh?.bundle?.patch !== 'string') {
    throw new Error('Artifact package identity/version/bundle does not match the catalog')
  }
  return bytes
}

async function sourceDirectory(repo, entry) {
  const matches = []
  for (const directory of await readdir(join(repo, 'plugins'), { withFileTypes: true })) {
    if (!directory.isDirectory()) continue
    const path = join(repo, 'plugins', directory.name)
    const manifest = JSON.parse(await readFile(join(path, 'package.json'), 'utf8'))
    if (manifest.name === entry.package) matches.push({ path, manifest })
  }
  if (matches.length !== 1 || typeof matches[0].manifest.scripts?.build !== 'string') throw new Error('Cannot find a buildable source package for ' + entry.package)
  return matches[0]
}

async function validateBuiltSource({ path, manifest }) {
  const clientExport = manifest.exports?.['./client']
  const entries = [manifest.main, manifest.dsh?.bundle?.patch]
  if (manifest.dsh?.client) entries.push(typeof clientExport === 'string' ? clientExport : clientExport?.default)
  for (const entry of entries) {
    if (typeof entry !== 'string' || !resolve(path, entry).startsWith(path + sep)) throw new Error('Invalid source entry point')
    if (!(await optionalFile(resolve(path, entry)))) throw new Error('Missing built source entry: ' + entry)
  }
}

async function placeBundle(manifestPath, entry) {
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
  const bundles = manifest.dsh?.profile?.bundles
  if (!Array.isArray(bundles) || !bundles.every(item => typeof item === 'string')) throw new Error('Invalid profile bundle list')
  const current = bundles.indexOf(entry.package), anchor = bundles.indexOf('@deepseek-ai/dsh-web-app')
  if (current < 0 || anchor < 0) throw new Error('Installed plugin or Web App is missing from the profile')
  if (entry.placement === 'before-web-app' ? current < anchor : current > anchor) return
  bundles.splice(current, 1)
  const index = bundles.indexOf('@deepseek-ai/dsh-web-app')
  bundles.splice(index + (entry.placement === 'after-web-app' ? 1 : 0), 0, entry.package)
  await atomicWrite(manifestPath, JSON.stringify(manifest, null, 2) + '\n')
}

export async function managePlugin({ action, plugin, source = false, repo = repository, directory = defaultDirectory(repo), execute = run, log = console.log }) {
  if (!['install', 'remove', 'list'].includes(action)) throw new Error('Use dhp plugin install|remove|list')
  if (source && action !== 'install') throw new Error('--source applies only to plugin install')
  const installation = await readInstallation(directory, repo)
  const { root, dshHome, profile, launcher } = installation
  const manifestPath = join(profile, 'package.json')
  const env = { ...process.env, DSH_HOME: dshHome,
    PATH: dirname(process.execPath) + ':' + join(root, 'runtime/node_modules/.bin') + ':' + (process.env.PATH ?? '') }
  const invoke = args => execute(launcher, ['plugin', '--profile', 'web', '--config.ignore-scripts=true', ...args], { cwd: repo, env })
  log('DSH profile: ' + profile)
  if (action === 'list') {
    await listPlugins(repo, profile, log)
    return
  }
  const entry = await catalogEntry(repo, plugin)
  let bytes, sourcePackage
  if (action === 'install') {
    const runtime = JSON.parse(await readFile(join(root, 'runtime/node_modules/@deepseek-ai/dsh/package.json'), 'utf8'))
    if (typeof entry.dshVersion !== 'string' || entry.dshVersion !== runtime.version) throw new Error('Plugin is incompatible with the installed DSH version')
    if (source) sourcePackage = await sourceDirectory(repo, entry)
    else bytes = await releaseArtifact(repo, entry)
  }
  await mkdir(profile, { recursive: true, mode: 0o700 })
  const lockPath = join(profile, '.local-plugin.lock')
  let lock
  try { lock = await open(lockPath, 'wx', 0o600) } catch (error) {
    if (error.code === 'EEXIST') throw new Error('Another plugin command holds .local-plugin.lock; do not remove it while that process runs')
    throw error
  }
  try {
    await lock.writeFile(String(process.pid) + '\n')
    const snapshots = await Promise.all(['package.json', 'pnpm-lock.yaml'].map(async name => ({ path: join(profile, name), bytes: await optionalFile(join(profile, name)) })))
    try {
      if (action === 'remove') {
        const manifest = snapshots[0].bytes && JSON.parse(snapshots[0].bytes)
        if (!manifest?.dependencies?.[entry.package]) { log('Plugin is not installed: ' + entry.package); return }
        await invoke(['remove', entry.package])
      } else {
        let installPath
        if (sourcePackage) {
          const pnpm = join(root, 'runtime/node_modules/.bin/pnpm')
          await execute(pnpm, ['install', '--frozen-lockfile', '--ignore-scripts'], { cwd: repo, env })
          await execute(pnpm, ['--filter', entry.package, 'run', 'build'], { cwd: repo, env })
          await validateBuiltSource(sourcePackage)
          installPath = sourcePackage.path
        } else {
          const cache = join(dshHome, 'plugin-cache')
          await mkdir(cache, { recursive: true, mode: 0o700 })
          installPath = join(cache, entry.artifact.sha256 + '.tgz')
          const existing = await optionalFile(installPath)
          if (existing && digest(existing) !== entry.artifact.sha256) throw new Error('Cached artifact SHA-256 mismatch')
          if (!existing) await atomicWrite(installPath, bytes)
        }
        await invoke(['add', installPath, '--save-exact'])
        await placeBundle(manifestPath, entry)
      }
    } catch (error) {
      for (const snapshot of snapshots) {
        if (snapshot.bytes === undefined) await rm(snapshot.path, { force: true })
        else await atomicWrite(snapshot.path, snapshot.bytes)
      }
      throw error
    }
    log((action === 'install' ? 'Installed: ' : 'Removed: ') + entry.package + '. Complete this batch of plugin changes, then run dhp restart once to apply them. Restarting ends the current AI turn; continue after the app reconnects.')
  } finally { await lock.close(); await unlink(lockPath) }
}

/** Reinstall every catalog plugin already declared in the profile. */
export async function updateInstalledPlugins({ source = false, repo = repository, directory = defaultDirectory(repo), execute = run, log = console.log }) {
  const installation = await readInstallation(directory, repo)
  log('DSH profile: ' + installation.profile)
  const declared = await declaredCatalogEntries(repo, installation.profile)
  if (declared.length === 0) {
    log('No catalog plugins are installed.')
    return
  }
  const targets = []
  for (const entry of declared) {
    const name = pluginName(entry)
    const installed = await installedPackageVersion(installation.profile, entry.package)
    if (!source && installed === entry.version) {
      log('Already current: ' + name + ' ' + installed)
      continue
    }
    targets.push(name)
  }
  if (targets.length === 0) {
    log('Installed catalog plugins already match the local release.')
    return
  }
  for (const plugin of targets) {
    await managePlugin({ action: 'install', plugin, source, repo, directory, execute, log })
  }
}

/** Execute the single CLI declared by an installed catalog plugin. */
export async function executePlugin({ plugin, args = [], repo = repository, directory = defaultDirectory(repo), execute = run }) {
  const installation = await readInstallation(directory, repo)
  const entry = await catalogEntry(repo, plugin)
  const profileBytes = await optionalFile(join(installation.profile, 'package.json'))
  const profileManifest = profileBytes ? JSON.parse(profileBytes) : {}
  if (!Object.hasOwn(profileManifest.dependencies ?? {}, entry.package)) {
    throw new Error('Plugin is not installed: ' + entry.package)
  }
  const packageRoot = join(installation.profile, 'node_modules', entry.package)
  const manifest = JSON.parse(await readFile(join(packageRoot, 'package.json'), 'utf8'))
  if (manifest.name !== entry.package) throw new Error('Installed plugin package identity does not match the catalog')
  const bins = typeof manifest.bin === 'string'
    ? [[entry.package.split('/').at(-1), manifest.bin]]
    : Object.entries(manifest.bin ?? {})
  if (bins.length !== 1 || typeof bins[0][1] !== 'string') {
    throw new Error('Plugin must declare exactly one executable in package.json')
  }
  const executable = resolve(packageRoot, bins[0][1])
  if (!executable.startsWith(packageRoot + sep)) throw new Error('Plugin executable escapes its package directory')
  const stat = await lstat(executable)
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Plugin executable must be a regular file')
  const env = {
    ...process.env,
    DSH_HOME: installation.dshHome,
    PATH: dirname(process.execPath) + ':' + join(installation.root, 'runtime/node_modules/.bin') + ':' + (process.env.PATH ?? ''),
  }
  await execute(process.execPath, [executable, ...args], { cwd: repo, env })
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    if (process.argv.length !== 3) throw new Error('Expected one plugin action')
    const source = process.env.DSH_PLUGIN_SOURCE || '0'
    if (!['0', '1'].includes(source)) throw new Error('SOURCE must be 0 or 1')
    await managePlugin({ action: process.argv[2], plugin: process.env.DSH_PLUGIN_NAME,
      source: source === '1', directory: process.env.DSH_PLUGIN_DIR || undefined })
  } catch (error) { console.error('Plugin command failed: ' + error.message); process.exitCode = 1 }
}
