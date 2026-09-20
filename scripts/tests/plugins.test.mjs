import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { cp, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { managePlugin, updateInstalledPlugins } from '../plugins.mjs'

const repository = fileURLToPath(new URL('../../', import.meta.url))
const catalog = JSON.parse(await readFile(join(repository, 'marketplace.json'), 'utf8'))
const baseBundles = ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', '@example/existing']
const json = async path => JSON.parse(await readFile(path, 'utf8'))
/** The version a release bumps, so publishing does not have to edit these assertions. */
const localVersion = id => catalog.plugins.find(entry => entry.id === id).version.replaceAll('.', String.raw`\.`)

async function fixture(t, id = 'wechat', legacy = false) {
  const scratch = await mkdtemp(join(tmpdir(), 'dsh-plugins-test-'))
  t.after(() => rm(scratch, { recursive: true, force: true }))
  const directory = join(scratch, "installation 'with spaces'"), repo = join(scratch, 'repository')
  const dshHome = legacy ? join(directory, 'home') : join(scratch, 'user/.dsh')
  const profile = join(dshHome, 'profiles/web')
  const entry = catalog.plugins.find(entry => entry.id === id)
  const folder = id === 'trusted-marketplace' ? 'marketplace' : id
  for (const path of [profile, join(directory, 'bin'), join(directory, 'runtime/node_modules/@deepseek-ai/dsh'),
    join(directory, 'runtime/node_modules/.bin'), join(repo, 'artifacts'), join(repo, 'plugins', folder)]) await mkdir(path, { recursive: true })
  await writeFile(join(directory, 'bootstrap-state.json'), JSON.stringify({ owner: 'shamcleren/dsh-plugin/bootstrap-v1', schemaVersion: legacy ? 1 : 2, status: 'ready', dshHome }))
  await writeFile(join(directory, 'runtime/node_modules/@deepseek-ai/dsh/package.json'), JSON.stringify({ version: '0.1.5-rc.1' }))
  await writeFile(join(directory, 'bin/dsh'), '#!/bin/sh\nexit 0\n', { mode: 0o700 })
  await cp(join(repository, 'marketplace.json'), join(repo, 'marketplace.json'))
  await cp(join(repository, entry.artifact.path), join(repo, entry.artifact.path))
  for (const file of ['package.json', 'cordis.patch.yml']) await cp(join(repository, 'plugins', folder, file), join(repo, 'plugins', folder, file))
  await writeFile(join(profile, 'package.json'), JSON.stringify({ dependencies: { '@example/existing': '1.0.0' }, dsh: { profile: { bundles: baseBundles } } }))
  await writeFile(join(profile, 'pnpm-lock.yaml'), 'existing lockfile\n')
  const calls = [], logs = []
  const execute = async (command, args, settings) => {
    calls.push({ command, args, settings })
    if (command !== join(directory, 'bin/dsh')) {
      if (args.includes('build')) {
        await mkdir(join(repo, 'plugins', folder, 'lib'), { recursive: true })
        await writeFile(join(repo, 'plugins', folder, 'lib/index.js'), 'export {}\n')
      }
      return
    }
    const manifest = await json(join(profile, 'package.json'))
    if (args.includes('add')) {
      const installPath = args[args.indexOf('add') + 1]
      const sha = String(installPath).split('/').at(-1)?.replace(/\.tgz$/u, '')
      const match = catalog.plugins.find(item => item.artifact.sha256 === sha) ?? entry
      manifest.dependencies[match.package] = 'file:' + installPath
      if (!manifest.dsh.profile.bundles.includes(match.package)) manifest.dsh.profile.bundles.push(match.package)
    } else if (args.includes('remove')) {
      delete manifest.dependencies[entry.package]
      manifest.dsh.profile.bundles = manifest.dsh.profile.bundles.filter(name => name !== entry.package)
    }
    await writeFile(join(profile, 'package.json'), JSON.stringify(manifest))
  }
  const options = { directory, repo, plugin: id, execute, log: line => logs.push(line) }
  return { ...options, options, scratch, profile, dshHome, entry, calls, logs, execute }
}

test('short install verifies and caches a release, invokes official CLI, and applies before-Web placement', async t => {
  const f = await fixture(t)
  await managePlugin({ ...f.options, action: 'install' })
  const cache = join(f.dshHome, 'plugin-cache', f.entry.artifact.sha256 + '.tgz')
  assert.deepEqual(await readFile(cache), await readFile(join(f.repo, f.entry.artifact.path)))
  assert.deepEqual(f.calls[0].args, ['plugin', '--profile', 'web', '--config.ignore-scripts=true', 'add', cache, '--save-exact'])
  assert.equal(f.calls[0].settings.env.DSH_HOME, f.dshHome)
  const manifest = await json(join(f.profile, 'package.json'))
  assert.deepEqual(manifest.dsh.profile.bundles, ['@deepseek-ai/dsh-base', f.entry.package, '@deepseek-ai/dsh-web-app', '@example/existing'])
  assert.equal(manifest.dependencies['@example/existing'], '1.0.0')
  assert.ok(!(await readdir(f.profile)).includes('.local-plugin.lock'))
})

test('marketplace is a short alias; after-Web packages stay behind the Web App', async t => {
  const f = await fixture(t, 'trusted-marketplace')
  await managePlugin({ ...f.options, action: 'install', plugin: 'marketplace' })
  assert.ok((await json(join(f.profile, 'package.json'))).dependencies[f.entry.package])
  assert.deepEqual((await json(join(f.profile, 'package.json'))).dsh.profile.bundles, [...baseBundles, f.entry.package])
})

test('remove uses the supported pnpm config flag and leaves other plugins intact', async t => {
  const f = await fixture(t)
  await managePlugin({ ...f.options, action: 'install' })
  f.calls.length = 0
  await managePlugin({ ...f.options, action: 'remove' })
  assert.deepEqual(f.calls[0].args, ['plugin', '--profile', 'web', '--config.ignore-scripts=true', 'remove', f.entry.package])
  assert.deepEqual((await json(join(f.profile, 'package.json'))).dsh.profile.bundles, baseBundles)
  f.calls.length = 0
  await managePlugin({ ...f.options, action: 'remove' })
  assert.equal(f.calls.length, 0)
})

test('missing, ambiguous, incompatible or tampered releases fail before mutation', async t => {
  const f = await fixture(t)
  await assert.rejects(managePlugin({ ...f.options, action: 'install', plugin: '../outside' }), /Choose a plugin name/)
  const manifest = await readFile(join(f.profile, 'package.json'))
  const path = join(f.repo, f.entry.artifact.path)
  const bytes = await readFile(path)
  bytes[0] ^= 1
  await writeFile(path, bytes)
  await assert.rejects(managePlugin({ ...f.options, action: 'install' }), /SHA-256 mismatch/)
  await cp(join(repository, f.entry.artifact.path), path)
  const data = await json(join(f.repo, 'marketplace.json'))
  const entry = data.plugins.find(entry => entry.id === f.entry.id)
  entry.version = '9.9.9'
  await writeFile(join(f.repo, 'marketplace.json'), JSON.stringify(data))
  await assert.rejects(managePlugin({ ...f.options, action: 'install' }), /identity\/version/)
  entry.dshVersion = '0.1.0-rc.9'
  await writeFile(join(f.repo, 'marketplace.json'), JSON.stringify(data))
  await assert.rejects(managePlugin({ ...f.options, action: 'install' }), /incompatible/)
  data.plugins.push(entry)
  await writeFile(join(f.repo, 'marketplace.json'), JSON.stringify(data))
  await assert.rejects(managePlugin({ ...f.options, action: 'install' }), /Choose a plugin name/)
  assert.equal(f.calls.length, 0)
  assert.deepEqual(await readFile(join(f.profile, 'package.json')), manifest)
})

test('failed CLI mutations restore profile metadata and release the lock', async t => {
  const f = await fixture(t)
  const before = await readFile(join(f.profile, 'package.json'))
  await assert.rejects(managePlugin({ ...f.options, action: 'install', execute: async (...args) => {
    await f.execute(...args)
    await writeFile(join(f.profile, 'pnpm-lock.yaml'), 'partial mutation')
    throw new Error('CLI failed')
  } }), /CLI failed/)
  assert.deepEqual(await readFile(join(f.profile, 'package.json')), before)
  assert.equal(await readFile(join(f.profile, 'pnpm-lock.yaml'), 'utf8'), 'existing lockfile\n')
  assert.ok(!(await readdir(f.profile)).includes('.local-plugin.lock'))
})

test('source installation prepares dependencies and builds before adding the local directory', async t => {
  const f = await fixture(t, 'wecom-tools')
  await managePlugin({ ...f.options, action: 'install', source: true })
  assert.deepEqual(f.calls[0].args, ['install', '--frozen-lockfile', '--ignore-scripts'])
  assert.deepEqual(f.calls[1].args, ['--filter', f.entry.package, 'run', 'build'])
  assert.equal(f.calls[2].args[f.calls[2].args.indexOf('add') + 1], join(f.repo, 'plugins/wecom-tools'))
})

test('unfinished source builds cannot install missing entry points', async t => {
  const f = await fixture(t, 'wecom-tools')
  await assert.rejects(managePlugin({ ...f.options, action: 'install', source: true, execute: async () => {} }), /Missing built source entry/)
  assert.deepEqual((await json(join(f.profile, 'package.json'))).dsh.profile.bundles, baseBundles)
})

test('listing includes every catalog plugin and resolves installed release and linked source versions without mutation', async t => {
  const f = await fixture(t)
  const source = catalog.plugins.find(entry => entry.id === 'wecom-tools')
  const incomplete = catalog.plugins.find(entry => entry.id === 'web-search')
  const manifestPath = join(f.profile, 'package.json')
  const manifest = await json(manifestPath)
  Object.assign(manifest.dependencies, {
    [f.entry.package]: 'file:/cached/release.tgz',
    [source.package]: 'link:/local/source',
    [incomplete.package]: incomplete.version,
  })
  await writeFile(manifestPath, JSON.stringify(manifest))
  const installed = join(f.profile, 'node_modules', f.entry.package)
  await mkdir(installed, { recursive: true })
  await writeFile(join(installed, 'package.json'), JSON.stringify({ name: f.entry.package, version: '0.1.0' }))
  const sourcePath = join(f.scratch, 'linked source')
  await mkdir(sourcePath)
  await writeFile(join(sourcePath, 'package.json'), JSON.stringify({ name: source.package, version: source.version }))
  await symlink(sourcePath, join(f.profile, 'node_modules', source.package))
  // A stale node_modules entry without a declared dependency is not an installed profile plugin.
  const stale = catalog.plugins.find(entry => entry.id === 'codex-controller')
  await mkdir(join(f.profile, 'node_modules', stale.package), { recursive: true })
  await writeFile(join(f.profile, 'node_modules', stale.package, 'package.json'), JSON.stringify({ name: stale.package, version: stale.version }))
  const before = await readFile(manifestPath)
  await managePlugin({ ...f.options, action: 'list' })
  assert.equal(f.calls.length, 0)
  const output = f.logs.join('\n')
  assert.match(output, new RegExp(String.raw`^wechat\s+已安装\s+0\.1\.0 / ${localVersion('wechat')}$`, 'm'))
  assert.match(output, new RegExp(String.raw`^wecom-tools\s+已安装\s+0\.2\.0 / ${localVersion('wecom-tools')}$`, 'm'))
  assert.match(output, new RegExp(String.raw`^web-search\s+安装不完整\s+- / ${localVersion('web-search')}$`, 'm'))
  assert.match(output, new RegExp(String.raw`^marketplace\s+未安装\s+- / ${localVersion('trusted-marketplace')}$`, 'm'))
  assert.match(output, new RegExp(String.raw`^codex-controller\s+未安装\s+- / ${localVersion('codex-controller')}$`, 'm'))
  for (const entry of catalog.plugins) {
    const name = entry.id === 'trusted-marketplace' ? 'marketplace' : entry.id
    assert.equal(f.logs.filter(line => line.startsWith(name + ' ')).length, 1)
  }
  assert.deepEqual(await readFile(manifestPath), before)
  assert.equal(await readFile(join(f.profile, 'pnpm-lock.yaml'), 'utf8'), 'existing lockfile\n')
  assert.ok(!(await readdir(f.profile)).includes('.local-plugin.lock'))
})

test('listing respects legacy profiles and does not create an absent profile', async t => {
  const f = await fixture(t, 'wechat', true)
  await managePlugin({ ...f.options, action: 'list' })
  assert.equal(f.logs[0], 'DSH profile: ' + join(f.directory, 'home/profiles/web'))
  assert.equal(f.calls.length, 0)
  await rm(f.profile, { recursive: true })
  f.logs.length = 0
  await managePlugin({ ...f.options, action: 'list' })
  assert.equal(f.calls.length, 0)
  assert.equal(f.logs.filter(line => line.includes('未安装')).length, catalog.plugins.length)
  await assert.rejects(readFile(join(f.profile, 'package.json')), { code: 'ENOENT' })
})

test('listing rejects catalog package paths outside node_modules', async t => {
  const f = await fixture(t)
  const data = await json(join(f.repo, 'marketplace.json'))
  data.plugins[0].package = '../../outside'
  await writeFile(join(f.repo, 'marketplace.json'), JSON.stringify(data))
  await assert.rejects(managePlugin({ ...f.options, action: 'list' }), /Invalid catalog package name/)
  assert.equal(f.calls.length, 0)
})

test('concurrent plugin commands cannot modify the same profile', async t => {
  const f = await fixture(t)
  let entered, release
  const started = new Promise(resolve => { entered = resolve })
  const gate = new Promise(resolve => { release = resolve })
  const first = managePlugin({ ...f.options, action: 'install', execute: async (...args) => { entered(); await gate; await f.execute(...args) } })
  await started
  try { await assert.rejects(managePlugin({ ...f.options, action: 'install' }), /holds .local-plugin.lock/) }
  finally { release(); await first }
})

test('update --all reinstalls declared catalog plugins and skips uninstalled ones', async t => {
  const f = await fixture(t)
  const other = catalog.plugins.find(entry => entry.id === 'wecom-aibot')
  await mkdir(join(f.repo, 'plugins/wecom-aibot'), { recursive: true })
  await cp(join(repository, other.artifact.path), join(f.repo, other.artifact.path))
  await cp(join(repository, 'plugins/wecom-aibot/package.json'), join(f.repo, 'plugins/wecom-aibot/package.json'))
  await managePlugin({ ...f.options, action: 'install' })
  const installed = join(f.profile, 'node_modules', f.entry.package)
  await mkdir(installed, { recursive: true })
  await writeFile(join(installed, 'package.json'), JSON.stringify({ name: f.entry.package, version: f.entry.version }))
  const manifest = await json(join(f.profile, 'package.json'))
  manifest.dependencies[other.package] = other.version
  await writeFile(join(f.profile, 'package.json'), JSON.stringify(manifest))
  f.calls.length = 0
  f.logs.length = 0
  await updateInstalledPlugins({ ...f.options })
  assert.match(f.logs.join('\n'), new RegExp(String.raw`Already current: wechat ${f.entry.version.replaceAll('.', String.raw`\.`)}`))
  const added = f.calls.filter(call => call.args.includes('add'))
  assert.equal(added.length, 1)
  assert.equal(added[0].args.at(-2).endsWith(other.artifact.sha256 + '.tgz'), true)
  assert.ok((await json(join(f.profile, 'package.json'))).dependencies[other.package])
})

test('update --all does not install plugins that were never declared', async t => {
  const f = await fixture(t)
  f.calls.length = 0
  await updateInstalledPlugins({ ...f.options })
  assert.equal(f.calls.length, 0)
  assert.match(f.logs.join('\n'), /No catalog plugins are installed/)
})

test('update --all --source still rebuilds a plugin already at the catalog version', async t => {
  const f = await fixture(t, 'wecom-tools')
  await managePlugin({ ...f.options, action: 'install', source: true })
  const installed = join(f.profile, 'node_modules', f.entry.package)
  await mkdir(installed, { recursive: true })
  await writeFile(join(installed, 'package.json'), JSON.stringify({ name: f.entry.package, version: f.entry.version }))
  f.calls.length = 0
  await updateInstalledPlugins({ ...f.options, source: true })
  assert.deepEqual(f.calls[1].args, ['--filter', f.entry.package, 'run', 'build'])
})

test('./dhp plugin list works with private Node and a quoted --dir, without Node on PATH', async t => {
  const f = await fixture(t)
  await mkdir(join(f.repo, 'scripts'))
  for (const file of ['dhp.mjs', 'plugins.mjs', 'process.mjs', 'installation.mjs', 'service.mjs']) {
    await cp(join(repository, 'scripts', file), join(f.repo, 'scripts', file))
  }
  await cp(join(repository, 'dhp'), join(f.repo, 'dhp'))
  await mkdir(join(f.directory, 'node/bin'), { recursive: true })
  await symlink(process.execPath, join(f.directory, 'node/bin/node'))
  const tools = join(f.scratch, 'tools')
  await mkdir(tools)
  await symlink('/usr/bin/dirname', join(tools, 'dirname'))
  await writeFile(join(f.directory, 'bin/dsh'), '#!/bin/sh\nexit 99\n')
  const result = spawnSync('/bin/sh', [join(f.repo, 'dhp'), '--dir', f.directory, 'plugin', 'list'], { env: { PATH: tools, HOME: f.scratch }, encoding: 'utf8', timeout: 10000 })
  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, new RegExp(String.raw`^wechat\s+未安装\s+- / ${localVersion('wechat')}$`, 'm'))
  assert.match(result.stdout, new RegExp(String.raw`^marketplace\s+未安装\s+- / ${localVersion('trusted-marketplace')}$`, 'm'))
})
