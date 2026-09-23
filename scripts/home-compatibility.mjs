/** Compatibility checks and recoverable Web-profile upgrades; never rewrite user credentials. */
import { createHash, randomUUID } from 'node:crypto'
import { cp, lstat, mkdir, open, readFile, readdir, readlink, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { releaseArtifact } from './plugins.mjs'

const journalName = '.dhp-profile-update.json'
const owner = 'dhp-profile-update-v1'
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const json = async path => JSON.parse(await readFile(path, 'utf8'))
async function stat(path) { try { return await lstat(path) } catch (error) { if (error.code !== 'ENOENT') throw error } }
async function safeDirectory(path) {
  // A home can live below /var or another OS alias; reject user-controlled final components.
  const info = await stat(path)
  if (info && (!info.isDirectory() || info.isSymbolicLink())) throw new Error('Expected a real directory: ' + path)
  if (!info) await mkdir(path, { recursive: true, mode: 0o700 })
}
async function regular(path) {
  const info = await stat(path)
  if (!info) return undefined
  if (!info.isFile() || info.isSymbolicLink()) throw new Error('Expected a regular file: ' + path)
  return readFile(path)
}
async function exclusiveFile(path, bytes) {
  const fd = await open(path, 'wx', 0o600)
  try { await fd.writeFile(bytes); await fd.sync() } finally { await fd.close() }
}

export { lockDshHome } from './home-lock.mjs'

/** Ask the selected official provider to validate both known layouts, without revealing values. */
export async function checkCredentials({ home, runtime, log = console.log }) {
  const filename = join(home, '.credentials.yaml'), bytes = await regular(filename)
  if (!bytes) return
  const info = await stat(filename)
  if (process.platform !== 'win32' && ((info.mode & 0o077) !== 0 || info.uid !== process.getuid())) throw new Error('Existing .credentials.yaml must be owned by this user with mode 600. Correct its permissions before retrying; no credentials were changed.')
  const require = createRequire(join(runtime, 'package.json'))
  const { parseCredentialsDocument, renderFlatLayoutMigration } = await import(pathToFileURL(require.resolve('@deepseek-ai/dsh-credentials-local')).href)
  let migration
  try {
    migration = renderFlatLayoutMigration(bytes.toString('utf8'))
    parseCredentialsDocument(migration ?? bytes.toString('utf8'), filename)
  } catch { throw new Error('Existing .credentials.yaml is not supported by the selected DSH release. The file was left unchanged; use a matching DSH release or an isolated DSH_HOME. Do not flatten or delete credentials.') }
  if (migration === undefined) return
  const backups = join(home, '.dhp-backups')
  await safeDirectory(backups)
  const backup = join(backups, 'credentials-' + hash(bytes) + '.yaml')
  const previous = await regular(backup)
  if (previous && process.platform !== 'win32' && ((await stat(backup)).mode & 0o077) !== 0) throw new Error('Existing credential backup must have mode 600; no credentials were changed')
  if (previous && !previous.equals(bytes)) throw new Error('Credential backup does not match; refusing to overwrite it')
  if (!previous) await exclusiveFile(backup, bytes)
  log('Old credential format backed up: ' + backup + '. Official DSH will upgrade it on first launch.')
}

/** Check every installed direct dependency, including third-party plugins, against the new runtime. */
export async function verifyProfilePeers(profile, runtime, ignored = new Set()) {
  const bytes = await regular(join(profile, 'package.json'))
  if (!bytes) return
  const manifest = JSON.parse(bytes), semver = createRequire(join(runtime, 'package.json'))('semver')
  for (const name of Object.keys(manifest.dependencies ?? {})) {
    if (!/^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/.test(name)) throw new Error('Invalid installed package name')
    if (ignored.has(name)) continue
    const plugin = await json(join(profile, 'node_modules', name, 'package.json'))
    for (const [peer, range] of Object.entries(plugin.peerDependencies ?? {})) {
      if (!/^@deepseek-ai\/dsh(?:-[a-z0-9-]+)?$/.test(peer)) continue
      const actualBytes = await regular(join(runtime, 'node_modules', peer, 'package.json'))
      if (!actualBytes && plugin.peerDependenciesMeta?.[peer]?.optional) continue
      const actual = actualBytes ? JSON.parse(actualBytes).version : 'unavailable'
      if (typeof range !== 'string' || !semver.valid(actual) || !semver.satisfies(actual, range)) throw new Error('Runtime update is incompatible with installed ' + name + ': ' + peer + ' requires ' + range + ', new runtime has ' + actual + '. Update/remove that plugin with the old installation first, or use an isolated DSH_HOME.')
    }
  }
}

async function profileFingerprint(profile) {
  if (!(await stat(profile))) return null
  const parts = []
  for (const entry of (await readdir(profile)).sort()) {
    if (entry === 'node_modules') continue
    const path = join(profile, entry), info = await stat(path)
    if (['.dsh-module-fallback', '.plugin-manager'].includes(entry) && info.isDirectory() && !info.isSymbolicLink()) {
      // Official profiles own module links and Plugin Manager metadata here.
      // Preserve both trees and detect edits without following their links.
      parts.push(entry, await profileTreeFingerprint(path))
      continue
    }
    if (!info.isFile() || info.isSymbolicLink()) throw new Error('Unsupported profile entry; preserve it and use an isolated DSH_HOME: ' + entry)
    parts.push(entry, hash(await readFile(path)))
  }
  return hash(JSON.stringify(parts))
}

async function profileTreeFingerprint(root, depth = 0) {
  if (depth > 16) throw new Error('Unsupported profile metadata depth')
  const parts = []
  for (const name of (await readdir(root)).sort()) {
    const path = join(root, name), info = await lstat(path)
    if (info.isSymbolicLink()) parts.push([name, 'link', await readlink(path)])
    else if (info.isFile()) parts.push([name, 'file', hash(await readFile(path))])
    else if (info.isDirectory()) parts.push([name, 'directory', await profileTreeFingerprint(path, depth + 1)])
    else throw new Error('Unsupported profile metadata entry: ' + name)
  }
  return hash(JSON.stringify(parts))
}

/** Keep pnpm local package locators valid when a staged profile is moved. */
export async function stabilizeProfileLock(profile, runtime) {
  const path = join(profile, 'pnpm-lock.yaml'), bytes = await regular(path)
  if (!bytes) return
  const { parseDocument, visit } = createRequire(join(runtime, 'package.json'))('yaml')
  const document = parseDocument(bytes.toString('utf8'))
  if (document.errors.length) throw new Error('Invalid profile lockfile; refusing to relocate it')
  const importer = document.toJS()?.importers?.['.'], replacements = new Map()
  for (const section of ['dependencies', 'devDependencies', 'optionalDependencies']) {
    for (const dependency of Object.values(importer?.[section] ?? {})) {
      const spec = dependency?.specifier
      if (typeof spec !== 'string' || !/^(?:file|link):/.test(spec)) continue
      const colon = spec.indexOf(':'), protocol = spec.slice(0, colon + 1), target = spec.slice(colon + 1)
      if (!isAbsolute(target)) continue
      replacements.set(protocol + relative(profile, target), spec)
    }
  }
  if (!replacements.size) return
  const ordered = [...replacements].sort(([a], [b]) => b.length - a.length)
  visit(document, { Scalar(_key, node) {
    if (typeof node.value !== 'string') return
    for (const [from, to] of ordered) node.value = node.value.replaceAll(from, to)
  } })
  await writeFile(path, document.toString())
}

/** Read-only release comparison, including same-runtime plugin updates. */
export async function homeProfileNeedsUpdate({ home, repo, release }) {
  const profile = join(home, 'profiles/web')
  const bytes = await regular(join(profile, 'package.json'))
  if (!bytes) return false
  return (await catalogReplacements(profile, JSON.parse(bytes), repo, release, false)).length > 0
}

async function catalogReplacements(profile, manifest, repo, release, marketplace) {
  const catalog = await json(join(repo, 'marketplace.json'))
  const entries = []
  for (const entry of catalog.plugins) {
    const installed = manifest?.dependencies?.[entry.package]
    if (!installed && !(marketplace && entry.id === 'trusted-marketplace')) continue
    if (entry.dshVersion !== release.dshVersion) throw new Error('Catalog runtime does not match ' + entry.package)
    let current
    if (installed) current = await json(join(profile, 'node_modules', entry.package, 'package.json'))
    if (current?.version === entry.version) continue
    entries.push(entry)
  }
  return entries
}

/** Prepare with the official plugin installer, in the same filesystem as the target profile. */
export async function prepareHomeProfile({ root, home, repo, runtime, release, nodeExecutable, env, execute, log, marketplace = false }) {
  await safeDirectory(home)
  await checkCredentials({ home, runtime, log })
  const profiles = join(home, 'profiles'), profile = join(profiles, 'web')
  if (await stat(profiles)) await safeDirectory(profiles)
  if (await stat(profile)) await safeDirectory(profile)
  const bytes = await regular(join(profile, 'package.json')), manifest = bytes ? JSON.parse(bytes) : undefined
  if (!manifest && !marketplace) return undefined
  const entries = await catalogReplacements(profile, manifest, repo, release, marketplace)
  const replacements = []
  for (const entry of entries) replacements.push({ entry, artifact: await releaseArtifact(repo, entry) })
  await verifyProfilePeers(profile, runtime, new Set(replacements.map(item => item.entry.package)))
  if (replacements.length === 0) return undefined
  await safeDirectory(profiles)
  const before = await profileFingerprint(profile)
  const stageName = '.dhp-web-' + randomUUID(), stage = join(profiles, stageName)
  const stagingHome = join(stage, 'next'), stagedProfile = join(stagingHome, 'profiles/web')
  const retainedLinks = []
  await mkdir(stage, { mode: 0o700 })
  try {
    if (manifest) {
      await cp(profile, stagedProfile, { recursive: true, verbatimSymlinks: true })
      // Preserve meanings of local dependencies when the profile moves for staging.
      const next = structuredClone(manifest)
      for (const [name, spec] of Object.entries(next.dependencies ?? {})) {
        if (typeof spec === 'string' && /^(file|link):\.{1,2}\//.test(spec)) next.dependencies[name] = spec.slice(0, spec.indexOf(':') + 1) + resolve(profile, spec.slice(spec.indexOf(':') + 1))
        if (typeof spec === 'string' && spec.startsWith('link:') && !replacements.some(item => item.entry.package === name)) {
          retainedLinks.push({ name, target: resolve(profile, spec.slice(5)) })
        }
        const original = join(profile, 'node_modules', name)
        if ((await lstat(original)).isSymbolicLink()) {
          const target = await readlink(original), absolute = resolve(dirname(original), target)
          const fromProfile = relative(profile, absolute)
          if (!isAbsolute(target) && (fromProfile === '..' || fromProfile.startsWith('../') || isAbsolute(fromProfile))) {
            // pnpm's source links are relative even for an absolute link: spec.
            // Only the staged copy changes; external source directories stay intact.
            const copied = join(stagedProfile, 'node_modules', name)
            await rm(copied)
            await symlink(absolute, copied)
          }
        }
      }
      await writeFile(join(stagedProfile, 'package.json'), JSON.stringify(next, null, 2) + '\n')
    }
    const cache = join(home, 'plugin-cache')
    await safeDirectory(cache)
    const artifacts = []
    for (const { entry, artifact } of replacements) {
      const path = join(cache, entry.artifact.sha256 + '.tgz'), existing = await regular(path)
      if (existing && !existing.equals(artifact)) throw new Error('Cached plugin artifact digest mismatch')
      if (!existing) await exclusiveFile(path, artifact)
      artifacts.push(path)
    }
    log('Preparing compatible plugins: ' + replacements.map(item => item.entry.id).join(', '))
    const buildEnv = { ...env, DSH_HOME: stagingHome, PATH: dirname(nodeExecutable) + ':' + join(runtime, 'node_modules/.bin') + ':' + env.PATH }
    const cli = join(runtime, 'node_modules/@deepseek-ai/dsh/lib/bin.js')
    await execute(nodeExecutable, [cli, 'plugin', '--profile', 'web', '--config.ignore-scripts=true', 'add', ...artifacts, ...retainedLinks.map(({ name, target }) => name + '@link:' + target), '--save-exact'], { cwd: runtime, env: buildEnv })
    // Explicit add refreshes pnpm's relative lock entry for staging. Absolute
    // links remain valid when this staged profile is published at its final path.
    for (const { name, target } of retainedLinks) {
      const path = join(stagedProfile, 'node_modules', name)
      if (!(await lstat(path)).isSymbolicLink()) throw new Error('Expected retained source link: ' + name)
      await rm(path)
      await symlink(target, path)
    }
    await verifyProfilePeers(stagedProfile, runtime)
    const next = await json(join(stagedProfile, 'package.json'))
    const bundles = next.dsh?.profile?.bundles
    if (!Array.isArray(bundles) || !bundles.includes('@deepseek-ai/dsh-web-app')) throw new Error('Updated Web profile is missing its official app bundle')
    for (const { entry } of replacements) {
      const index = bundles.indexOf(entry.package)
      if (index < 0) throw new Error('Updated plugin did not register its bundle: ' + entry.package)
      bundles.splice(index, 1)
      bundles.splice(bundles.indexOf('@deepseek-ai/dsh-web-app') + (entry.placement === 'after-web-app' ? 1 : 0), 0, entry.package)
    }
    await writeFile(join(stagedProfile, 'package.json'), JSON.stringify(next, null, 2) + '\n')
    await execute(nodeExecutable, [cli, '--profile', 'web', '--dump-config'], { cwd: runtime, env: buildEnv, stdio: ['ignore', 'ignore', 'inherit'] })
    await stabilizeProfileLock(stagedProfile, runtime)
    return { root, home, stageName, runtimeDigest: release.runtimeDigest, existed: !!manifest, before }
  } catch (error) { await rm(stage, { recursive: true, force: true }); throw error }
}

export async function publishHomeProfile(transaction) {
  if (!transaction) return
  const { home, stageName, root, runtimeDigest, existed, before, updateId } = transaction
  const profile = join(home, 'profiles/web'), stage = join(home, 'profiles', stageName)
  if (before !== await profileFingerprint(profile)) throw new Error('The Web profile changed during installation. Close DSH and retry; no profile was replaced.')
  await exclusiveFile(join(home, journalName), JSON.stringify({ owner, root, runtimeDigest, stageName, existed, updateId }))
  if (existed) await rename(profile, join(stage, 'previous'))
  await rename(join(stage, 'next/profiles/web'), profile)
}

/** Match the committed profile transaction too: runtime versions can remain unchanged. */
export async function recoverHomeProfile({ root, home, runtimeDigest, profileUpdateId, ready, log = () => {} }) {
  const bytes = await regular(join(home, journalName))
  if (!bytes) return
  const journal = JSON.parse(bytes)
  if (journal.owner !== owner || journal.root !== root || !/^\.dhp-web-[a-f0-9-]+$/.test(journal.stageName) || typeof journal.existed !== 'boolean') throw new Error('Profile upgrade belongs to another installation or has an invalid journal; finish that installation first')
  const stage = join(home, 'profiles', journal.stageName), profile = join(home, 'profiles/web'), backup = join(stage, 'previous'), next = join(stage, 'next/profiles/web')
  for (const path of [join(home, 'profiles'), stage]) {
    const info = await stat(path)
    if (!info?.isDirectory() || info.isSymbolicLink()) throw new Error('Unsafe profile upgrade staging directory')
  }
  for (const path of [join(stage, 'next'), join(stage, 'next/profiles'), profile, backup, next]) {
    const info = await stat(path)
    if (info && (!info.isDirectory() || info.isSymbolicLink())) throw new Error('Unsafe profile upgrade target')
  }
  const committed = ready && journal.runtimeDigest === runtimeDigest &&
    (journal.updateId === undefined || journal.updateId === profileUpdateId)
  if (!committed) {
    if (await stat(backup)) { await rm(profile, { recursive: true, force: true }); await rename(backup, profile) }
    else if (!journal.existed && !(await stat(next))) await rm(profile, { recursive: true, force: true })
  } else if (await stat(backup)) {
    const backups = join(home, '.dhp-backups'); await safeDirectory(backups)
    const destination = join(backups, 'web-profile-' + journal.stageName.slice('.dhp-web-'.length))
    await rename(backup, destination)
    log('Previous Web profile preserved: ' + destination)
  }
  await rm(stage, { recursive: true, force: true })
  await rm(join(home, journalName))
}

export async function discardHomeProfile(transaction) {
  if (!transaction) return
  await recoverHomeProfile({ ...transaction, ready: false })
  await rm(join(transaction.home, 'profiles', transaction.stageName), { recursive: true, force: true })
}
