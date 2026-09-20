import { fakeInstall } from './installer-fixture.mjs'
import assert from 'node:assert/strict'
import { cp, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { execFileSync, fork } from 'node:child_process'
import { bootstrap, parseArgs, releaseInfo } from '../bootstrap.mjs'
import { run } from '../process.mjs'

const repo = dirname(dirname(dirname(fileURLToPath(import.meta.url))))
async function fixture(t) {
  const scratch = await mkdtemp(join(tmpdir(), 'dsh-bootstrap-test-'))
  t.after(() => rm(scratch, { recursive: true, force: true }))
  return { directory: join(scratch, 'installation with spaces'), dshHome: join(scratch, 'user/.dsh'),
    userHome: join(scratch, 'user'), desktop: false, repo, log() {} }
}

test('arguments reject unknown flags and missing directory values', () => {
  assert.equal(parseArgs(['--no-app', '--resume']).desktop, false)
  assert.equal(parseArgs([]).desktop, process.platform === 'darwin')
  assert.equal(parseArgs([]).marketplace, false)
  assert.equal(parseArgs([]).directory, join(repo, 'dist'))
  assert.equal(parseArgs(['--with-marketplace']).marketplace, true)
  assert.throws(() => parseArgs(['--dir']), /requires/)
  assert.throws(() => parseArgs(['--force']), /Unknown/)
})

test('opt-in Marketplace install pins official packages, skips lifecycle scripts, and leaves ready profiles untouched', async t => {
  const options = { ...await fixture(t), marketplace: true }
  const calls = []
  const execute = async (command, args, settings) => { calls.push({ command, args, settings }); await fakeInstall(command, args, settings) }
  const first = await bootstrap({ ...options, execute })
  assert.equal(first.reused, false)
  assert.equal(calls.length, 4)
  assert.equal(calls[0].command, 'npm')
  assert.ok(calls[0].args.includes('--package=pnpm@11.7.0'))
  assert.ok(calls[0].args.includes('--ignore-scripts'))
  assert.ok(calls[2].args.includes('--config.ignore-scripts=true'))
  assert.ok(calls[2].settings.env.DSH_HOME.startsWith(options.dshHome + '/profiles/.dhp-web-'))
  await mkdir(options.dshHome, { recursive: true })
  const sentinel = join(options.dshHome, 'settings.yaml')
  await writeFile(sentinel, 'user-owned configuration')
  calls.length = 0
  assert.equal((await bootstrap({ ...options, marketplace: false, dshHome: undefined, execute })).reused, true)
  assert.equal(calls.length, 1)
  assert.equal(calls[0].args.at(-1), '--version')
  assert.equal(await readFile(sentinel, 'utf8'), 'user-owned configuration')
})

test('default installation needs no catalog or artifacts and never installs plugins', async t => {
  const options = await fixture(t)
  const minimalRepo = join(dirname(options.directory), 'runtime-only-release')
  await mkdir(minimalRepo)
  await cp(join(repo, 'runtime'), join(minimalRepo, 'runtime'), { recursive: true, filter: path => !path.includes('node_modules') })
  await cp(join(repo, 'scripts'), join(minimalRepo, 'scripts'), { recursive: true })
  const calls = [], logs = []
  const execute = async (command, args) => { calls.push({ command, args }) }
  const clean = { ...options, repo: minimalRepo, execute, log: line => logs.push(line) }
  await bootstrap(clean)
  assert.equal(calls.length, 2)
  assert.equal(calls[0].command, 'npm')
  assert.equal(calls[1].args.at(-1), '--version')
  await assert.rejects(readFile(join(options.directory, 'artifacts/marketplace.tgz')), { code: 'ENOENT' })
  const state = JSON.parse(await readFile(join(options.directory, 'bootstrap-state.json')))
  assert.equal(state.status, 'ready')
  assert.equal(state.marketplaceSha256, null)
  assert.ok(logs.some(line => line.startsWith('1/1 ')))
  assert.ok(!logs.some(line => /authorize|Gongfeng/.test(line)))
  assert.equal((await bootstrap(clean)).reused, true)
  await assert.rejects(bootstrap({ ...options, marketplace: true, execute }), /dhp plugin install marketplace/)
})

test('resume cannot change the selected marketplace mode', async t => {
  const options = { ...await fixture(t), marketplace: true }
  await assert.rejects(bootstrap({ ...options, execute: async () => { throw new Error('offline') } }), /offline/)
  const calls = []
  const execute = async (command, args, settings) => { calls.push(args); await fakeInstall(command, args, settings) }
  await assert.rejects(bootstrap({ ...options, marketplace: false, resume: true, execute }), /options differ/)
  assert.equal(calls.length, 0)
  await bootstrap({ ...options, resume: true, execute })
  assert.ok(calls.some(args => args.includes('plugin')))
})

test('the installed executable launcher handles quoted paths and works without Node on PATH', async t => {
  const base = await fixture(t)
  const options = { ...base, directory: base.directory + " 'quoted'" }
  await bootstrap({ ...options, execute: async () => {} })
  const cli = join(options.directory, 'runtime/node_modules/@deepseek-ai/dsh/lib')
  await mkdir(cli, { recursive: true })
  await writeFile(join(cli, 'bin.js'), 'console.log(JSON.stringify({ args: process.argv.slice(2), home: process.env.DSH_HOME, path: process.env.PATH }))')
  const launcher = join(options.directory, 'bin/dsh')
  const invoke = args => JSON.parse(execFileSync(launcher, args, { env: { PATH: '' }, encoding: 'utf8' }))
  const custom = invoke(['--version', 'argument with spaces'])
  assert.deepEqual(custom.args, ['--version', 'argument with spaces'])
  assert.equal(custom.home, options.dshHome)
  assert.ok(custom.path.startsWith(dirname(process.execPath) + ':'))
  assert.deepEqual(invoke([]).args, ['web', '--host', '127.0.0.1', '--port', '3080', '--no-open'])
  const markerPath = join(options.directory, 'bootstrap-state.json')
  const state = JSON.parse(await readFile(markerPath, 'utf8'))
  await writeFile(markerPath, JSON.stringify({ ...state, dshHome: 'relative/path' }))
  assert.throws(() => invoke([]), /Invalid DSH configuration directory/)
  await writeFile(markerPath, JSON.stringify({ ...state, schemaVersion: 1, dshHome: undefined }))
  assert.equal(invoke([]).home, join(await realpath(options.directory), 'home'))
  for (const name of ['.bootstrap.lock', '.update-transaction.json']) {
    await writeFile(join(options.directory, name), 'pending update')
    assert.throws(() => invoke([]), /Installation is updating/)
    await rm(join(options.directory, name))
  }
})

test('init publishes a user-local dhp command bound to the installation', async t => {
  const options = await fixture(t)
  await bootstrap({ ...options, execute: async () => {}, pathEnv: '' })
  const command = join(options.userHome, '.local/bin/dhp')
  assert.equal(await realpath(command), await realpath(join(options.directory, 'bin/dhp')))
  const help = execFileSync(command, ['help'], { encoding: 'utf8' })
  assert.match(help, /plugin exec/)
  const profile = join(options.userHome, process.platform === 'darwin' ? '.zprofile' : '.profile')
  assert.match(await readFile(profile, 'utf8'), /dsh-plugin: dhp on PATH/)
  await bootstrap({ ...options, execute: async () => {}, pathEnv: '' })
  assert.equal((await readFile(profile, 'utf8')).split('dsh-plugin: dhp on PATH').length - 1, 1)
  await rm(command)
  await writeFile(command, 'not a symlink\n')
  await assert.rejects(bootstrap({ ...options, execute: async () => {}, pathEnv: join(options.userHome, '.local/bin') }), /Refusing to replace/)
})

test('init does not rewrite the shell profile when ~/.local/bin is already on PATH', async t => {
  const options = await fixture(t)
  const bin = join(options.userHome, '.local/bin')
  await bootstrap({ ...options, execute: async () => {}, pathEnv: bin })
  await assert.rejects(readFile(join(options.userHome, process.platform === 'darwin' ? '.zprofile' : '.profile')), { code: 'ENOENT' })
})

test('default home is ~/.dsh independently of the installation directory', async t => {
  const options = await fixture(t)
  const originalHome = process.env.HOME
  process.env.HOME = options.userHome
  t.after(() => { if (originalHome === undefined) delete process.env.HOME; else process.env.HOME = originalHome })
  const calls = []
  await bootstrap({ ...options, dshHome: undefined, execute: async (_command, _args, settings) => { calls.push(settings.env) } })
  assert.equal(calls[0].DSH_HOME, join(homedir(), '.dsh'))
  const state = JSON.parse(await readFile(join(options.directory, 'bootstrap-state.json'), 'utf8'))
  assert.equal(state.schemaVersion, 2)
  assert.equal(state.dshHome, join(homedir(), '.dsh'))
})

test('first initialization preserves existing shared settings and records the selected home for resume', async t => {
  const options = await fixture(t)
  await mkdir(options.dshHome, { recursive: true })
  const settings = join(options.dshHome, 'settings.yaml')
  const content = 'test-existing-model: keep\n'
  await writeFile(settings, content)
  await bootstrap({ ...options, execute: async () => {} })
  assert.equal(await readFile(settings, 'utf8'), content)
  await assert.rejects(bootstrap({ ...options, dshHome: join(options.directory, 'home'), execute: async () => {} }), /data directory differs/)
  const marker = join(options.directory, 'bootstrap-state.json')
  const state = JSON.parse(await readFile(marker, 'utf8'))
  await writeFile(marker, JSON.stringify({ ...state, schemaVersion: 1, dshHome: undefined }))
  await bootstrap({ ...options, dshHome: undefined, execute: async () => {}, assertIdle: async () => {} })
  assert.equal(JSON.parse(await readFile(marker, 'utf8')).dshHome, join(options.directory, 'home'))
  assert.equal(await readFile(settings, 'utf8'), content)
})

test('failed installs are explicit and can resume without deleting saved profile data', async t => {
  const options = await fixture(t)
  await assert.rejects(bootstrap({ ...options, execute: async () => { throw new Error('network unavailable') } }), /network unavailable/)
  assert.equal(JSON.parse(await readFile(join(options.directory, 'bootstrap-state.json'))).status, 'failed')
  await assert.rejects(bootstrap({ ...options, execute: async () => {} }), /--resume/)
  await bootstrap({ ...options, resume: true, execute: async () => {} })
  assert.equal(JSON.parse(await readFile(join(options.directory, 'bootstrap-state.json'))).status, 'ready')
})

test('unowned directories and symlink roots are never adopted', async t => {
  const options = await fixture(t)
  const existing = join(dirname(options.directory), 'existing')
  await mkdir(existing)
  await writeFile(join(existing, 'keep'), 'untouched')
  await assert.rejects(bootstrap({ ...options, directory: existing }), /not owned/)
  await symlink(existing, options.directory, 'dir')
  await assert.rejects(bootstrap(options), /real directory/)
  assert.equal(await readFile(join(existing, 'keep'), 'utf8'), 'untouched')
})

test('overlapping installers use an exclusive lock', async t => {
  const options = await fixture(t)
  let entered, release
  const started = new Promise(resolve => { entered = resolve })
  const gate = new Promise(resolve => { release = resolve })
  const first = bootstrap({ ...options, execute: async () => { entered(); await gate } })
  await started
  try { await assert.rejects(bootstrap({ ...options, resume: true, execute: async () => {} }), /holds .bootstrap.lock/) }
  finally { release(); await first }
})

for (const marketplace of [false, true]) test(`macOS initialization builds a reusable app (marketplace=${marketplace})`, async t => {
  const options = { ...await fixture(t), desktop: true, marketplace }
  const calls = []
  const execute = async (command, args, settings) => {
    calls.push({ command, args })
    await fakeInstall(command, args, settings)
    if (args.includes('--install-root')) {
      await mkdir(join(options.directory, 'DeepSeek Harness.app'), { recursive: true })
      await writeFile(join(options.directory, 'native-app.json'), JSON.stringify({ app: 'DeepSeek Harness.app' }))
    }
  }
  await bootstrap({ ...options, execute })
  assert.equal(calls[0].command, '/usr/bin/xcrun')
  assert.equal(calls.some(call => call.args.includes('plugin')), marketplace)
  assert.ok(calls.at(-1).args.includes('--install-root'))
  assert.equal(calls.length, marketplace ? 6 : 4)
  calls.length = 0
  await bootstrap({ ...options, execute })
  assert.equal(calls.length, 1)
})

test('artifact tampering and catalog traversal fail before installing anything', async t => {
  const options = await fixture(t)
  const copy = join(dirname(options.directory), 'release')
  await mkdir(copy)
  await cp(join(repo, 'runtime'), join(copy, 'runtime'), { recursive: true, filter: path => !path.includes('node_modules') })
  await cp(join(repo, 'marketplace.json'), join(copy, 'marketplace.json'))
  const catalog = JSON.parse(await readFile(join(copy, 'marketplace.json')))
  const entry = catalog.plugins.find(p => p.id === 'trusted-marketplace')
  await mkdir(join(copy, 'artifacts'))
  await writeFile(join(copy, entry.artifact.path), 'tampered')
  await assert.rejects(releaseInfo(copy, { marketplace: true }), /SHA-256 mismatch/)
  entry.artifact.path = '../outside.tgz'
  await writeFile(join(copy, 'marketplace.json'), JSON.stringify(catalog))
  await assert.rejects(releaseInfo(copy, { marketplace: true }), /Invalid Marketplace artifact/)
})

test('the process runner surfaces real spawn and exit failures', async () => {
  await assert.rejects(run('dsh-nonexistent-executable-971beeac', []), /ENOENT/)
  await assert.rejects(run(process.execPath, ['-e', 'process.exit(17)']), /17/)
})

test('a separate installer process cannot mutate a locked installation', async t => {
  const options = await fixture(t)
  const child = fork(fileURLToPath(new URL('./bootstrap-lock.fixture.mjs', import.meta.url)), [options.directory, repo, options.dshHome], { stdio: ['ignore', 'pipe', 'pipe', 'ipc'] })
  const exited = new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', (code, signal) => resolve({ code, signal })) })
  const timeout = setTimeout(() => child.kill('SIGKILL'), 15000)
  try {
    await Promise.race([
      new Promise(resolve => child.once('message', resolve)),
      exited.then(() => { throw new Error('Fixture exited before acquiring the lock') }),
    ])
    await assert.rejects(bootstrap({ ...options, resume: true, execute: async () => {} }), /holds .bootstrap.lock/)
  } finally {
    if (child.connected) child.send('release')
    const result = await exited
    clearTimeout(timeout)
    assert.deepEqual(result, { code: 0, signal: null })
  }
})
