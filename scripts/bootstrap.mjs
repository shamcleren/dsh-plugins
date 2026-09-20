import { lockDshHome, checkCredentials, prepareHomeProfile, publishHomeProfile, recoverHomeProfile, discardHomeProfile } from './home-compatibility.mjs'
/** Install the locked official runtime with an optional verified Marketplace. */
import { createHash, randomUUID } from 'node:crypto'
import { cp, lstat, mkdir, open, readFile, realpath, rename, unlink, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, resolve, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { run } from './process.mjs'
import { publishUserDhp, writeDhpLauncher } from './dhp-command.mjs'
import { assertInstallationIdle, installationDigests, readInstallationState, recoverInstallation, updateInstallation } from './update-installation.mjs'

const repository = dirname(dirname(fileURLToPath(import.meta.url)))
const owner = 'shamcleren/dsh-plugin/bootstrap-v1'
const markerName = 'bootstrap-state.json'
const runtimeFiles = ['package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml']

export function parseArgs(args) {
  const options = { directory: join(repository, 'dist'), resume: false, help: false, desktop: process.platform === 'darwin', marketplace: false, rebuildApp: false }
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--dir') {
      if (!args[i + 1] || args[i + 1].startsWith('--')) throw new Error('--dir requires a directory')
      options.directory = resolve(args[++i])
    } else if (args[i] === '--resume') options.resume = true
    else if (args[i] === '--no-app') options.desktop = false
    else if (args[i] === '--with-marketplace') options.marketplace = true
    else if (args[i] === '--rebuild-app') options.rebuildApp = true
    else if (args[i] === '--help') options.help = true
    else throw new Error('Unknown option: ' + args[i])
  }
  return options
}

async function exists(path) {
  try { return await lstat(path) } catch (error) { if (error.code !== 'ENOENT') throw error }
}

export async function releaseInfo(repo, { marketplace = false } = {}) {
  const runtime = JSON.parse(await readFile(join(repo, 'runtime/package.json'), 'utf8'))
  const dshVersion = runtime.dependencies['@deepseek-ai/dsh']
  if (!/^\d+\.\d+\.\d+(?:-[\w.]+)?$/.test(dshVersion)) throw new Error('DSH must use an exact release')
  const lock = await readFile(join(repo, 'runtime/pnpm-lock.yaml'), 'utf8')
  const workspace = await readFile(join(repo, 'runtime/pnpm-workspace.yaml'), 'utf8')
  const pnpmVersion = runtime.dependencies.pnpm
  if (!/^\d+\.\d+\.\d+$/.test(pnpmVersion)) throw new Error('pnpm must use an exact release')
  const release = { dshVersion, pnpmVersion,
    runtimeDigest: createHash('sha256').update(JSON.stringify(runtime)).update(lock).update(workspace).digest('hex') }
  if (!marketplace) return release
  const catalog = JSON.parse(await readFile(join(repo, 'marketplace.json'), 'utf8'))
  const entries = catalog.plugins.filter(entry => entry.id === 'trusted-marketplace')
  if (entries.length !== 1) throw new Error('Catalog must contain exactly one trusted Marketplace')
  const entry = entries[0]
  if (entry.dshVersion !== dshVersion) {
    throw new Error('Marketplace must pin the exact official runtime version')
  }
  if (entry.package !== '@shamcleren/dsh-plugin-marketplace' ||
      !/^artifacts\/[^/\\]+\.tgz$/.test(entry.artifact.path)) throw new Error('Invalid Marketplace artifact path or package')
  const artifact = join(repo, entry.artifact.path)
  const bytes = await readFile(artifact)
  const sha256 = createHash('sha256').update(bytes).digest('hex')
  if (bytes.length !== entry.artifact.size || sha256 !== entry.artifact.sha256) throw new Error('Marketplace artifact size or SHA-256 mismatch')
  return { ...release, packageName: entry.package, version: entry.version, sha256, artifact }
}

function validateDirectory(directory, repo) {
  const root = resolve(directory)
  if (root === dirname(root) || root === homedir() || root === resolve(repo) ||
      resolve(repo).startsWith(root + sep)) throw new Error('Choose a dedicated installation directory, not a home or repository ancestor')
  return root
}

async function writeState(root, state) {
  const temporary = join(root, markerName + '.' + randomUUID() + '.next')
  await writeFile(temporary, JSON.stringify(state, null, 2) + '\n', { mode: 0o600, flag: 'wx' })
  await rename(temporary, join(root, markerName))
}

/** The optional Marketplace comes from a verified tarball; plugin compilation is unnecessary. */
export async function bootstrap({ directory, resume = false, desktop = process.platform === 'darwin', marketplace = false, dshHome, rebuildApp = false, repo = repository, execute = run, log = console.log, assertIdle, userHome, pathEnv }) {
  if (dshHome !== undefined && (typeof dshHome !== 'string' || !isAbsolute(dshHome))) throw new Error('DSH configuration directory must be absolute')
  const nodeSource = process.env.DSH_BOOTSTRAP_NODE_ROOT
  if (nodeSource !== undefined && await realpath(join(nodeSource, 'bin/node')) !== await realpath(process.execPath)) {
    throw new Error('Private Node.js source must contain the running bootstrap executable')
  }
  const release = await releaseInfo(repo, { marketplace })
  const root = validateDirectory(directory, repo)
  let fresh = false
  await mkdir(dirname(root), { recursive: true })
  try { await mkdir(root, { mode: 0o700 }); fresh = true } catch (error) { if (error.code !== 'EEXIST') throw error }
  if (!(await lstat(root)).isDirectory() || (await lstat(root)).isSymbolicLink()) throw new Error('Installation directory must be a real directory')
  let state = fresh ? undefined : await readInstallationState(root)
  if (state && (state.owner !== owner || ![1, 2].includes(state.schemaVersion))) throw new Error('Invalid installation ownership or schema')
  const savedHome = state?.schemaVersion === 1 ? join(root, 'home') : state?.dshHome
  const selectedHome = dshHome ?? savedHome ?? process.env.DSH_HOME ?? join(homedir(), '.dsh')
  if (typeof selectedHome !== 'string' || !isAbsolute(selectedHome)) throw new Error('Invalid DSH configuration directory')
  if (state && savedHome !== resolve(selectedHome)) throw new Error('Installation data directory differs; existing data will not be migrated')
  if (state?.status === 'ready') desktop = desktop || state.desktop
  const digests = await installationDigests(repo, desktop, release.runtimeDigest)
  const expected = { owner, schemaVersion: 2, dshHome: resolve(selectedHome), desktop, dshVersion: release.dshVersion, runtimeDigest: release.runtimeDigest,
    marketplaceSha256: release.sha256 ?? null, ...digests }
  if (fresh) {
    state = { ...expected, status: 'installing' }
    await writeFile(join(root, markerName), JSON.stringify(state) + '\n', { flag: 'wx', mode: 0o600 })
  }
  if (!['installing', 'failed', 'ready'].includes(state.status)) throw new Error('Invalid installation status')
  if (state.status !== 'ready') {
    for (const key of ['dshHome', 'desktop', 'dshVersion', 'runtimeDigest', 'marketplaceSha256']) {
      if (state[key] !== expected[key]) throw new Error('Installation release or options differ; resume with the original options')
    }
  }
  const lockPath = join(root, '.bootstrap.lock')
  let lock
  try { lock = await open(lockPath, 'wx', 0o600) } catch (error) {
    if (error.code === 'EEXIST') throw new Error('Another installer holds .bootstrap.lock; do not remove it while that process runs')
    throw error
  }
  let unlockHome, profileUpdate, committed = false
  try {
    unlockHome = await lockDshHome(expected.dshHome)
    await lock.writeFile(String(process.pid) + '\n')
    for (const name of ['runtime', 'home', 'agents', 'artifacts', 'bin', 'cache', 'apps', 'node']) {
      const stat = await exists(join(root, name))
      if (stat && (!stat.isDirectory() || stat.isSymbolicLink())) throw new Error('Unsafe installation path: ' + name)
    }
    const launcher = join(root, 'bin/dsh.mjs')
    const commandLauncher = join(root, 'bin/dsh')
    const runtime = join(root, 'runtime')
    const privateNode = join(root, 'node/bin/node')
    let nodeExecutable = await exists(privateNode) ? privateNode : process.execPath
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/KEY|SECRET|TOKEN|PASSWORD|^NODE_OPTIONS$|^NODE_PATH$/i.test(key)))
    Object.assign(env, { DSH_HOME: expected.dshHome, DSH_AGENTS_HOME: join(root, 'agents'),
      PATH: dirname(nodeExecutable) + ':' + join(runtime, 'node_modules/.bin') + ':' + (process.env.PATH ?? ''), npm_config_cache: join(root, 'cache'),
      npm_config_registry: 'https://registry.npmjs.org/' })
    const cli = join(runtime, 'node_modules/@deepseek-ai/dsh/lib/bin.js')
    if (await exists(join(root, '.update-transaction.json'))) await (assertIdle ?? assertInstallationIdle)(root)
    await recoverInstallation(root)
    state = JSON.parse(await readFile(join(root, markerName), 'utf8'))
    await recoverHomeProfile({ root, home: expected.dshHome, runtimeDigest: state.runtimeDigest, ready: state.status === 'ready', log })
    if (state.status === 'ready') {
      if (marketplace && state.marketplaceSha256 == null) throw new Error('Use dhp plugin install marketplace to add the market to an existing installation')
      const changed = await updateInstallation({ root, repo, state, release, nodeExecutable, env, desktop, rebuildApp, execute, log,
        ...(assertIdle === undefined ? {} : { assertIdle }) })
      if (!changed) {
        await checkCredentials({ home: expected.dshHome, runtime, log })
        await execute(nodeExecutable, [cli, '--version'], { cwd: runtime, env })
      }
      if (desktop) await reportApp(root, log)
      if (!changed) log('Already up to date. Existing profile settings were left unchanged.')
      log('Start: ' + shellQuote(commandLauncher) + ' web --host 127.0.0.1 --port 3080')
      await writeDhpLauncher({ root, repo, node: nodeExecutable })
      await publishUserDhp({ launcher: join(root, 'bin/dhp'), userHome, pathEnv, log })
      return { root, launcher, reused: !changed, updated: changed }
    }
    if (!fresh && !resume) throw new Error('Incomplete installation; retry with --resume and the same --dir')
    try {
      if (desktop) {
        log('Checking Xcode Command Line Tools (use --no-app for Web only)…')
        await execute('/usr/bin/xcrun', ['--find', 'swiftc'], { cwd: root, env })
      }
      for (const name of ['runtime', 'bin', ...(marketplace ? ['artifacts'] : [])]) await mkdir(join(root, name), { recursive: true, mode: 0o700 })
      if (nodeSource !== undefined) {
        await cp(nodeSource, join(root, 'node'), { recursive: true, verbatimSymlinks: true })
        nodeExecutable = privateNode
        env.PATH = join(root, 'node/bin') + ':' + env.PATH
      }
      for (const name of runtimeFiles) await cp(join(repo, 'runtime', name), join(runtime, name))
      const steps = 1 + Number(marketplace) + Number(desktop)
      log('1/' + steps + ' Installing official @deepseek-ai/dsh@' + release.dshVersion + ' from npm…')
      await execute('npm', ['exec', '--yes', '--registry=https://registry.npmjs.org/', '--package=pnpm@' + release.pnpmVersion,
        '--', 'pnpm', 'install', '--frozen-lockfile', '--ignore-scripts', '--prod'], { cwd: runtime, env })
      await execute(nodeExecutable, [cli, '--version'], { cwd: runtime, env })
      profileUpdate = await prepareHomeProfile({ root, home: expected.dshHome, repo, runtime, release, nodeExecutable, env, execute, log, marketplace })
      await cp(join(repo, 'scripts/launch.mjs'), launcher)
      await cp(join(repo, 'scripts/process.mjs'), join(root, 'bin/process.mjs'))
      const launcherStat = await exists(commandLauncher)
      if (launcherStat && (!launcherStat.isFile() || launcherStat.isSymbolicLink())) throw new Error('Unsafe launcher path')
      await writeFile(commandLauncher, '#!/bin/sh\nexec ' + shellQuote(nodeExecutable) + ' ' + shellQuote(launcher) + ' "$@"\n', { mode: 0o700 })
      await writeDhpLauncher({ root, repo, node: nodeExecutable })
      if (desktop) {
        log(steps + '/' + steps + ' Building the macOS app with the shared DSH profile…')
        await execute(nodeExecutable, [join(repo, 'apps/macos/build.mjs'), '--install-root', root], { cwd: root, env })
        await reportApp(root, log)
      }
      await publishHomeProfile(profileUpdate)
      await writeState(root, { ...expected, status: 'ready' })
      committed = true
      await recoverHomeProfile({ root, home: expected.dshHome, runtimeDigest: release.runtimeDigest, ready: true, log })
      log('Ready. No account credentials were configured and no bot was enabled.')
      log('DSH configuration and data: ' + expected.dshHome)
      log('Start: ' + shellQuote(commandLauncher) + ' web --host 127.0.0.1 --port 3080')
      if (marketplace) log('Optional: open Settings → Plugins → Remote marketplace to connect a Gongfeng source. DSH and its native plugin UI remain available without it.')
      await publishUserDhp({ launcher: join(root, 'bin/dhp'), userHome, pathEnv, log })
      return { root, launcher, reused: false }
    } catch (error) {
      if (committed) throw error
      await discardHomeProfile(profileUpdate)
      await writeState(root, { ...expected, status: 'failed' })
      throw error
    }
  } finally { await unlockHome?.(); await lock.close(); await unlink(lockPath) }
}

function shellQuote(value) {
  return "'" + value.replaceAll("'", "'\\''") + "'"
}

async function reportApp(root, log) {
  const record = JSON.parse(await readFile(join(root, 'native-app.json'), 'utf8'))
  if (typeof record.app !== 'string' || !/^(?:apps\/)?[^/\\]+\.app$/.test(record.app)) throw new Error('Invalid native app record')
  const app = join(root, record.app)
  if (!(await exists(app))?.isDirectory()) throw new Error('Native app is missing')
  log('Open app: open ' + shellQuote(app))
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const options = parseArgs(process.argv.slice(2))
    if (options.help) console.log('Usage: node scripts/bootstrap.mjs [--dir <new-directory>] [--resume] [--no-app] [--with-marketplace] [--rebuild-app]\nInstalls official DSH without extra plugins by default. --with-marketplace adds the optional remote marketplace; source authorization can be configured later.\nRequires Node ^22.19 or >=24 and npm; supports macOS/Linux. macOS builds the native app by default (Xcode Command Line Tools required). Runtime/App default to the repository dist/ directory; configuration and data use ~/.dsh. Repeat to update the repository-pinned runtime and rebuild changed Apps. Existing configuration and profile plugins are preserved.')
    else {
      const [major, minor] = process.versions.node.split('.').map(Number)
      if (!((major === 22 && minor >= 19) || major >= 24)) throw new Error('Node ^22.19 or >=24 is required')
      if (!['darwin', 'linux'].includes(process.platform)) throw new Error('Bootstrap currently supports macOS and Linux')
      await bootstrap(options)
    }
  } catch (error) { console.error('Bootstrap failed: ' + error.message); process.exitCode = 1 }
}
