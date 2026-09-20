import { prepareHomeProfile, publishHomeProfile, recoverHomeProfile, discardHomeProfile } from './home-compatibility.mjs'
/** Staged, rollback-capable updates of installer-owned runtime and app files. */
import { execFile } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { cp, lstat, mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { promisify } from 'node:util'
import { quote, writeDhpLauncher } from './dhp-command.mjs'
import { assertInstallationIdle } from './installation.mjs'

const capture = promisify(execFile)
const marker = 'bootstrap-state.json'
const journalName = '.update-transaction.json'
const managed = /^(?:runtime|bin\/(?:dsh|dsh\.mjs|process\.mjs|dhp)|native-app\.json|bootstrap-state\.json|(?:apps\/)?[^/\\]+\.app)$/

export async function optionalStat(path) {
  try { return await lstat(path) } catch (error) { if (error.code !== 'ENOENT') throw error }
}

async function writeJson(path, value) {
  const next = path + '.' + randomUUID() + '.next'
  try { await writeFile(next, JSON.stringify(value, null, 2) + '\n', { flag: 'wx', mode: 0o600 }); await rename(next, path) }
  finally { await rm(next, { force: true }) }
}

async function digestTree(repo, paths, extra) {
  const hash = createHash('sha256').update(JSON.stringify(extra))
  async function visit(path) {
    const full = join(repo, path), stat = await lstat(full)
    if (stat.isSymbolicLink()) throw new Error('Build inputs cannot be symlinks: ' + path)
    if (stat.isDirectory()) {
      for (const child of (await readdir(full)).sort()) await visit(path + '/' + child)
    } else if (stat.isFile()) hash.update(path).update('\0').update(await readFile(full)).update('\0')
  }
  for (const path of paths) await visit(path)
  return hash.digest('hex')
}

export async function installationDigests(repo, desktop, runtimeDigest, port = process.env.DSH_APP_PORT ?? '3080', signingEnv = process.env) {
  const launcherDigest = await digestTree(repo, ['scripts/launch.mjs', 'scripts/process.mjs', 'scripts/dhp.mjs', 'scripts/dhp-command.mjs'], {})
  const appDigest = desktop ? await digestTree(repo, ['apps/macos/Sources', 'apps/macos/Control', 'apps/macos/Share', 'apps/macos/Resources', 'apps/macos/launcher',
    'apps/macos/build.mjs', 'apps/macos/share-build.mjs', 'apps/macos/build-options.mjs', 'apps/macos/build-output.mjs', 'apps/macos/package.json',
    'apps/macos/LICENSE', 'runtime/node-release.sha256'], { runtimeDigest, port, arch: process.arch, signing: signingEnv.CODESIGN_IDENTITY ?? '-', shareTeam: signingEnv.DSH_SHARE_TEAM_ID ?? null }) : null
  return { launcherDigest, appDigest }
}

export { assertInstallationIdle }

async function readApp(root) {
  const record = await optionalStat(join(root, 'native-app.json'))
  if (!record) return undefined
  if (!record.isFile() || record.isSymbolicLink()) throw new Error('Unsafe native App record')
  const value = JSON.parse(await readFile(join(root, 'native-app.json'), 'utf8'))
  if (value.shareSigning !== undefined && (!value.shareSigning || !/^[A-Z0-9]{10}$/.test(value.shareSigning.team) || typeof value.shareSigning.identity !== 'string' || !value.shareSigning.identity || value.shareSigning.identity === '-')) throw new Error('Invalid recorded share signing configuration')
  if (typeof value.app !== 'string' || !/^(?:apps\/)?[^/\\]+\.app$/.test(value.app)) throw new Error('Invalid native app record')
  if (value.servicePort === undefined) {
    const plist = join(root, value.app, 'Contents/Info.plist')
    if (await optionalStat(plist)) {
      const port = /<key>DSHServicePort<\/key>\s*<integer>(\d+)<\/integer>/.exec(await readFile(plist, 'utf8'))?.[1]
      if (port) value.servicePort = Number(port)
    }
  }
  if (value.servicePort !== undefined && (!Number.isInteger(value.servicePort) || value.servicePort < 1 || value.servicePort > 65535)) throw new Error('Invalid recorded App port')
  return value
}

/** Recover a previously interrupted commit after the installer lock is safely acquired. */
async function readJournal(root) {
  const path = join(root, journalName), stat = await optionalStat(path)
  if (!stat) return undefined
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Unsafe update journal')
  const journal = JSON.parse(await readFile(path, 'utf8'))
  if (journal.owner !== 'dsh-install-update-v1' || !/^\.update-[a-f0-9-]+$/.test(journal.stage) || !Array.isArray(journal.entries) ||
    typeof journal.committed !== 'boolean' || !journal.entries.every(entry => typeof entry.path === 'string' && managed.test(entry.path) && typeof entry.existed === 'boolean' && typeof entry.hasNext === 'boolean') ||
    new Set(journal.entries.map(entry => entry.path)).size !== journal.entries.length) throw new Error('Invalid update journal')
  const stage = join(root, journal.stage)
  const stageStat = await optionalStat(stage)
  if (!stageStat && journal.committed) return journal
  if (!stageStat?.isDirectory() || stageStat.isSymbolicLink()) throw new Error('Unsafe update staging directory')
  for (const entry of journal.entries) {
    for (const path of [join(root, entry.path), join(stage, 'previous', entry.path), join(stage, 'next', entry.path)]) {
      let ancestor = path
      while (ancestor !== root) {
        if ((await optionalStat(ancestor))?.isSymbolicLink()) throw new Error('Unsafe update path')
        ancestor = dirname(ancestor)
      }
    }
  }
  return journal
}

/** Read ownership evidence even if interruption occurred between the two marker renames. */
export async function readInstallationState(root) {
  const stat = await optionalStat(join(root, marker))
  if (stat?.isFile() && !stat.isSymbolicLink()) return JSON.parse(await readFile(join(root, marker), 'utf8'))
  if (stat) throw new Error('Unsafe installation marker')
  const journal = await readJournal(root)
  if (!journal) throw new Error('Directory is not owned by this installer; use a new --dir')
  return JSON.parse(await readFile(join(root, journal.stage, 'previous', marker), 'utf8'))
}

export async function recoverInstallation(root) {
  const journal = await readJournal(root)
  if (!journal) return
  const stage = join(root, journal.stage)
  if (journal.committed !== true) {
    for (const entry of [...journal.entries].reverse()) {
      const target = join(root, entry.path), backup = join(stage, 'previous', entry.path), next = join(stage, 'next', entry.path)
      if (await optionalStat(backup)) {
        await rm(target, { recursive: true, force: true }); await mkdir(dirname(target), { recursive: true }); await rename(backup, target)
      } else if (!entry.existed && entry.hasNext && !(await optionalStat(next))) await rm(target, { recursive: true, force: true })
    }
  }
  await rm(stage, { recursive: true, force: true })
  await rm(join(root, journalName))
}

export async function updateInstallation({ root, repo, state, release, nodeExecutable, env, desktop, rebuildApp = false, execute, log,
  assertIdle = assertInstallationIdle }) {
  const runtimeChanged = state.runtimeDigest !== release.runtimeDigest
  const oldApp = await readApp(root)
  const port = process.env.DSH_APP_PORT ?? (oldApp?.servicePort === undefined ? '3080' : String(oldApp.servicePort))
  const buildEnv = { ...env, DSH_APP_PORT: port,
    ...(oldApp?.shareSigning ? { DSH_SHARE_TEAM_ID: env.DSH_SHARE_TEAM_ID ?? oldApp.shareSigning.team, CODESIGN_IDENTITY: env.CODESIGN_IDENTITY ?? oldApp.shareSigning.identity } : {}) }
  const digests = await installationDigests(repo, desktop, release.runtimeDigest, port, buildEnv)
  const appChanged = desktop && (rebuildApp || state.appDigest !== digests.appDigest || !oldApp || !(await optionalStat(join(root, oldApp.app))))
  const launcherChanged = runtimeChanged || state.launcherDigest !== digests.launcherDigest
  if (!runtimeChanged && !appChanged && !launcherChanged && state.schemaVersion === 2) return false
  await assertIdle(root)
  const stageName = '.update-' + randomUUID(), stage = join(root, stageName), next = join(stage, 'next')
  await mkdir(stage, { mode: 0o700 })
  let publishing = false, committed = false, profileUpdate
  try {
    await mkdir(next, { mode: 0o700 })
    const runtime = runtimeChanged ? join(next, 'runtime') : join(root, 'runtime')
    if (runtimeChanged) {
      await mkdir(runtime)
      for (const name of ['package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml']) await cp(join(repo, 'runtime', name), join(runtime, name))
      log('Updating the locked official runtime to ' + release.dshVersion + '…')
      await execute('npm', ['exec', '--yes', '--registry=https://registry.npmjs.org/', '--package=pnpm@' + release.pnpmVersion,
        '--', 'pnpm', 'install', '--frozen-lockfile', '--ignore-scripts', '--prod'], { cwd: runtime, env: buildEnv })
      await execute(nodeExecutable, [join(runtime, 'node_modules/@deepseek-ai/dsh/lib/bin.js'), '--version'], { cwd: runtime, env: buildEnv })
      profileUpdate = await prepareHomeProfile({ root, home: env.DSH_HOME, repo, runtime, release, nodeExecutable, env: buildEnv, execute, log })
    }
    const paths = []
    if (runtimeChanged) paths.push('runtime')
    if (launcherChanged) {
      await mkdir(join(next, 'bin'))
      for (const file of ['launch.mjs', 'process.mjs']) await cp(join(repo, 'scripts', file), join(next, 'bin', file === 'launch.mjs' ? 'dsh.mjs' : file))
      await writeFile(join(next, 'bin/dsh'), '#!/bin/sh\nexec ' + quote(nodeExecutable) + ' ' + quote(join(root, 'bin/dsh.mjs')) + ' "$@"\n', { mode: 0o700 })
      await writeDhpLauncher({ root, repo, node: nodeExecutable, outputRoot: next })
      paths.push('bin/dsh', 'bin/dsh.mjs', 'bin/process.mjs', 'bin/dhp')
    }
    if (appChanged) {
      log('Building and validating the updated macOS App…')
      await execute(nodeExecutable, [join(repo, 'apps/macos/build.mjs'), '--install-root', root,
        '--runtime-root', runtime, '--output-dir', next], { cwd: root, env: buildEnv })
      const app = await readApp(next)
      if (app?.app !== 'DeepSeek Harness.app' || !(await optionalStat(join(next, app.app)))?.isDirectory()) throw new Error('Updated App was not produced')
      if (oldApp && oldApp.app !== app.app && await optionalStat(join(root, oldApp.app))) paths.push(oldApp.app)
      if ((!oldApp || oldApp.app !== app.app) && await optionalStat(join(root, app.app))) throw new Error('Refusing to replace an App not recorded by this installation')
      paths.push(app.app, 'native-app.json')
    }
    await writeJson(join(next, marker), { ...state, schemaVersion: 2, dshHome: env.DSH_HOME, desktop,
      dshVersion: release.dshVersion, runtimeDigest: release.runtimeDigest, ...digests, status: 'ready' })
    paths.push(marker)
    const entries = []
    for (const path of paths) {
      const stat = await optionalStat(join(root, path))
      if (!managed.test(path) || stat?.isSymbolicLink() || (stat && ((path === 'runtime' || path.endsWith('.app')) ? !stat.isDirectory() : !stat.isFile()))) throw new Error('Unsafe update target: ' + path)
      entries.push({ path, existed: !!stat, hasNext: !!(await optionalStat(join(next, path))) })
    }
    await assertIdle(root)
    const journal = { owner: 'dsh-install-update-v1', stage: stageName, entries, committed: false }
    await writeJson(join(root, journalName), journal)
    publishing = true
    await publishHomeProfile(profileUpdate)
    for (const entry of entries) {
      const target = join(root, entry.path), backup = join(stage, 'previous', entry.path)
      if (entry.existed) { await mkdir(dirname(backup), { recursive: true }); await rename(target, backup) }
      if (entry.hasNext) { await mkdir(dirname(target), { recursive: true }); await rename(join(next, entry.path), target) }
    }
    await execute(nodeExecutable, [join(root, 'runtime/node_modules/@deepseek-ai/dsh/lib/bin.js'), '--version'], { cwd: join(root, 'runtime'), env })
    await writeJson(join(root, journalName), { ...journal, committed: true })
    committed = true
    await recoverInstallation(root)
    await recoverHomeProfile({ root, home: env.DSH_HOME, runtimeDigest: release.runtimeDigest, ready: true, log })
    log('Updated. Existing DSH settings, credentials and profile plugins were preserved.')
    return true
  } catch (error) {
    if (committed) throw error
    if (publishing) await recoverInstallation(root)
    await discardHomeProfile(profileUpdate)
    if (!publishing) await rm(stage, { recursive: true, force: true })
    throw error
  }
}
