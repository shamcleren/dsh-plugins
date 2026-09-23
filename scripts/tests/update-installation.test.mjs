import { fakeInstall } from './installer-fixture.mjs'
import assert from 'node:assert/strict'
import { cp, mkdir, mkdtemp, readFile, readdir, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { bootstrap } from '../bootstrap.mjs'
import { readInstallationState, recoverInstallation } from '../update-installation.mjs'

const repository = fileURLToPath(new URL('../../', import.meta.url))
const json = async path => JSON.parse(await readFile(path, 'utf8'))

async function fixture(t) {
  const scratch = await mkdtemp(join(tmpdir(), 'dsh-update-test-'))
  t.after(() => rm(scratch, { recursive: true, force: true }))
  const repo = join(scratch, 'repository'), directory = join(scratch, 'installation'), dshHome = join(scratch, 'home')
  await mkdir(repo)
  for (const name of ['runtime', 'scripts', 'apps', 'artifacts']) await cp(join(repository, name), join(repo, name), {
    recursive: true, filter: path => !/\/(?:node_modules|dist|\.cache)(?:\/|$)/.test(path),
  })
  await cp(join(repository, 'marketplace.json'), join(repo, 'marketplace.json'))
  await mkdir(join(dshHome, 'profiles/web/node_modules/example'), { recursive: true })
  await writeFile(join(dshHome, 'profiles/web/package.json'), JSON.stringify({ dependencies: { example: '1.0.0' } }))
  await writeFile(join(dshHome, 'profiles/web/node_modules/example/package.json'), JSON.stringify({ name: 'example', version: '1.0.0' }))
  await writeFile(join(dshHome, 'settings.yaml'), 'model: keep\n')
  await writeFile(join(dshHome, '.credentials.yaml'), 'TEST_CREDENTIAL: keep\n', { mode: 0o600 })
  const calls = []
  const options = { repo, directory, dshHome, userHome: join(scratch, 'command-user'), desktop: true, log() {}, assertIdle: async () => {} }
  const execute = async (command, args, settings) => {
    calls.push({ command, args, settings })
    await fakeInstall(command, args, settings)
    if (args.includes('--install-root')) {
      const output = args.includes('--output-dir') ? args[args.indexOf('--output-dir') + 1] : directory
      await mkdir(join(output, 'DeepSeek Harness.app'), { recursive: true })
      await writeFile(join(output, 'DeepSeek Harness.app/build'), String(calls.length))
      await writeFile(join(output, 'native-app.json'), JSON.stringify({ app: 'DeepSeek Harness.app', version: 'test', servicePort: 3080 }))
    }
  }
  options.execute = execute
  await bootstrap(options)
  calls.length = 0
  return { ...options, options, scratch, calls, execute }
}

for (const input of ['Sources/Main.swift', 'Control/main.swift']) test('repeat init rebuilds changed ' + input + ' in place and then becomes a no-op', async t => {
  const f = await fixture(t)
  const source = join(f.repo, 'apps/macos', input)
  await writeFile(source, await readFile(source, 'utf8') + '\n// changed fixture\n')
  const before = await readFile(join(f.directory, 'DeepSeek Harness.app/build'), 'utf8')
  assert.equal((await bootstrap(f.options)).updated, true)
  assert.notEqual(await readFile(join(f.directory, 'DeepSeek Harness.app/build'), 'utf8'), before)
  assert.equal(f.calls.filter(call => call.command === 'npm').length, 0)
  f.calls.length = 0
  assert.equal((await bootstrap(f.options)).reused, true)
  assert.equal(f.calls.length, 1)
  assert.equal(await readFile(join(f.dshHome, 'settings.yaml'), 'utf8'), 'model: keep\n')
  assert.equal(await readFile(join(f.dshHome, '.credentials.yaml'), 'utf8'), 'TEST_CREDENTIAL: keep\n')
})

test('REBUILD repairs a missing app without deleting profile plugins or reinstalling the runtime', async t => {
  const f = await fixture(t)
  await rm(join(f.directory, 'DeepSeek Harness.app'), { recursive: true })
  await bootstrap(f.options)
  assert.equal(f.calls.some(call => call.args.includes('--output-dir')), true)
  assert.deepEqual((await json(join(f.dshHome, 'profiles/web/package.json'))).dependencies, { example: '1.0.0' })
  f.calls.length = 0
  await bootstrap({ ...f.options, rebuildApp: true })
  assert.equal(f.calls.some(call => call.args.includes('--output-dir')), true)
  assert.equal(f.calls.some(call => call.command === 'npm'), false)
})

test('updates preserve the recorded Share Extension signing settings', async t => {
  const f = await fixture(t)
  const shareSigning = { team: 'ABCDEFGHIJ', identity: 'Developer ID Application: Test (ABCDEFGHIJ)' }
  await writeFile(join(f.directory, 'native-app.json'), JSON.stringify({ app: 'DeepSeek Harness.app', servicePort: 3080, shareSigning }))
  await bootstrap({ ...f.options, rebuildApp: true })
  const build = f.calls.find(call => call.args.includes('--output-dir'))
  assert.equal(build.settings.env.DSH_SHARE_TEAM_ID, shareSigning.team)
  assert.equal(build.settings.env.CODESIGN_IDENTITY, shareSigning.identity)
})

test('runtime lock changes are installed in staging and preserve the current profile', async t => {
  const f = await fixture(t)
  const runtime = join(f.repo, 'runtime/package.json'), manifest = await json(runtime)
  manifest.description = 'changed runtime lock fixture'
  await writeFile(runtime, JSON.stringify(manifest))
  const beforeProfile = await readFile(join(f.dshHome, 'profiles/web/package.json'))
  const oldState = await json(join(f.directory, 'bootstrap-state.json'))
  await bootstrap(f.options)
  assert.notEqual((await json(join(f.directory, 'bootstrap-state.json'))).runtimeDigest, oldState.runtimeDigest)
  assert.equal(f.calls.filter(call => call.command === 'npm').length, 1)
  assert.match(f.calls.find(call => call.command === 'npm').settings.cwd, /\.update-.*\/next\/runtime$/)
  assert.deepEqual(await readFile(join(f.dshHome, 'profiles/web/package.json')), beforeProfile)
  assert.equal((await readdir(f.directory)).some(name => name.startsWith('.update-')), false)
})

test('legacy App records preserve the signed desktop port during a rebuild', async t => {
  const f = await fixture(t)
  await writeFile(join(f.directory, 'native-app.json'), JSON.stringify({ app: 'DeepSeek Harness.app' }))
  await mkdir(join(f.directory, 'DeepSeek Harness.app/Contents'))
  await writeFile(join(f.directory, 'DeepSeek Harness.app/Contents/Info.plist'), '<plist><dict><key>DSHServicePort</key><integer>3186</integer></dict></plist>')
  await bootstrap({ ...f.options, rebuildApp: true })
  assert.equal(f.calls.find(call => call.args.includes('--output-dir')).settings.env.DSH_APP_PORT, '3186')
})

test('a runtime that violates an installed plugin peer range cannot replace the old install', async t => {
  const f = await fixture(t)
  const runtime = join(f.repo, 'runtime/package.json'), manifest = await json(runtime)
  manifest.dependencies['@deepseek-ai/dsh'] = '0.1.0-rc.9'
  await writeFile(runtime, JSON.stringify(manifest))
  await writeFile(join(f.dshHome, 'profiles/web/node_modules/example/package.json'), JSON.stringify({ name: 'example', peerDependencies: { '@deepseek-ai/dsh': '0.1.0-rc.8' } }))
  const before = await readFile(join(f.directory, 'bootstrap-state.json'))
  await assert.rejects(bootstrap(f.options), /incompatible with installed example/)
  assert.deepEqual(await readFile(join(f.directory, 'bootstrap-state.json')), before)
  assert.equal((await json(join(f.directory, 'runtime/node_modules/@deepseek-ai/dsh/package.json'))).version, JSON.parse(before).dshVersion)
})

test('build failures and failed post-publish checks leave the old app and state usable', async t => {
  const f = await fixture(t)
  const before = await readFile(join(f.directory, 'bootstrap-state.json'))
  const app = await readFile(join(f.directory, 'DeepSeek Harness.app/build'))
  await assert.rejects(bootstrap({ ...f.options, rebuildApp: true, execute: async (_command, args) => {
    if (args.includes('--output-dir')) throw new Error('compile failed')
  } }), /compile failed/)
  await assert.rejects(bootstrap({ ...f.options, rebuildApp: true, execute: async (command, args, settings) => {
    if (args.includes('--version')) throw new Error('verification failed')
    await f.execute(command, args, settings)
  } }), /verification failed/)
  assert.deepEqual(await readFile(join(f.directory, 'bootstrap-state.json')), before)
  assert.deepEqual(await readFile(join(f.directory, 'DeepSeek Harness.app/build')), app)
  assert.equal((await readdir(f.directory)).some(name => name.startsWith('.update-')), false)
})

test('a running installation is rejected before building or replacing anything', async t => {
  const f = await fixture(t)
  await assert.rejects(bootstrap({ ...f.options, rebuildApp: true, assertIdle: async () => { throw new Error('still running') } }), /still running/)
  assert.equal(f.calls.length, 0)
})

test('recovery restores a marker lost between renames and rejects paths outside the installation', async t => {
  const f = await fixture(t)
  const stage = '.update-123abc'
  await mkdir(join(f.directory, stage, 'previous'), { recursive: true })
  await rename(join(f.directory, 'bootstrap-state.json'), join(f.directory, stage, 'previous/bootstrap-state.json'))
  const journal = { owner: 'dsh-install-update-v1', stage, committed: false, entries: [{ path: 'bootstrap-state.json', existed: true, hasNext: true }] }
  await writeFile(join(f.directory, '.update-transaction.json'), JSON.stringify(journal))
  assert.equal((await readInstallationState(f.directory)).status, 'ready')
  await assert.rejects(bootstrap({ ...f.options, assertIdle: async () => { throw new Error('still running') } }), /still running/)
  await assert.rejects(readFile(join(f.directory, 'bootstrap-state.json')), { code: 'ENOENT' })
  await recoverInstallation(f.directory)
  assert.equal((await json(join(f.directory, 'bootstrap-state.json'))).status, 'ready')
  journal.entries[0].path = '../outside'
  await writeFile(join(f.directory, '.update-transaction.json'), JSON.stringify(journal))
  await assert.rejects(recoverInstallation(f.directory), /Invalid update journal/)
})

test('same-runtime updates install changed catalog plugins and then become a no-op', async t => {
  const f = await fixture(t)
  const profile = join(f.dshHome, 'profiles/web')
  const entry = (await json(join(f.repo, 'marketplace.json'))).plugins.find(item => item.id === 'trusted-marketplace')
  const manifest = await json(join(profile, 'package.json'))
  manifest.dependencies[entry.package] = '0.0.1'
  manifest.dsh = { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', entry.package] } }
  await writeFile(join(profile, 'package.json'), JSON.stringify(manifest))
  await mkdir(join(profile, 'node_modules', entry.package), { recursive: true })
  await writeFile(join(profile, 'node_modules', entry.package, 'package.json'), JSON.stringify({ name: entry.package, version: '0.0.1' }))
  const before = await json(join(f.directory, 'bootstrap-state.json'))
  assert.equal((await bootstrap(f.options)).updated, true)
  const after = await json(join(f.directory, 'bootstrap-state.json'))
  assert.equal(after.runtimeDigest, before.runtimeDigest)
  assert.ok(after.profileUpdateId)
  assert.equal((await json(join(profile, 'node_modules', entry.package, 'package.json'))).version, entry.version)
  assert.equal(f.calls.some(call => call.command === 'npm' || call.args.includes('--output-dir')), false)
  f.calls.length = 0
  assert.equal((await bootstrap(f.options)).reused, true)
  assert.equal(f.calls.length, 1)
})
