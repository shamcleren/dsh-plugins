import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { runDhp } from '../dhp.mjs'
import { listOwnedProcesses } from '../installation.mjs'
import { executePlugin } from '../plugins.mjs'
import { controlService } from '../service.mjs'

const repository = fileURLToPath(new URL('../../', import.meta.url))

test('dhp help does not require an installation', async () => {
  const lines = []
  assert.equal(await runDhp(['help'], { log: line => lines.push(line) }), 0)
  const text = lines.join('\n')
  assert.match(text, /plugin exec/)
  assert.match(text, /plugin update --all/)
})

test('Make exposes only init and help, with daily commands documented as dhp', () => {
  const help = spawnSync('/usr/bin/make', ['help'], {
    cwd: repository, encoding: 'utf8', timeout: 5000,
  })
  assert.equal(help.status, 0, help.stderr)
  assert.match(help.stdout, /^ {2}dhp plugin install wechat$/m)
  const removed = spawnSync('/usr/bin/make', ['plugin-install'], {
    cwd: repository, encoding: 'utf8', timeout: 5000,
  })
  assert.notEqual(removed.status, 0)
})

test('listOwnedProcesses ignores other directories and non-DSH commands', async () => {
  const root = '/tmp/dsh-owned'
  const processes = await listOwnedProcesses(root, {
    canonicalize: async () => root,
    inspect: async () => ({ stdout: [
      '  11 /tmp/other/runtime/node_modules/@deepseek-ai/dsh/lib/bin.js web',
      '  12 /tmp/dsh-owned/runtime/node_modules/@deepseek-ai/dsh/lib/bin.js web',
      '  13 /tmp/dsh-owned/DeepSeek Harness.app/Contents/MacOS/DeepSeekHarness',
      '  14 /usr/bin/node /tmp/dsh-owned/unrelated.js',
      '  15 /tmp/dsh-owned/DeepSeek Harness.app/Contents/MacOS/DeepSeekHarnessControl',
    ].join('\n') }),
  })
  assert.deepEqual(processes.map(item => item.pid), [12, 13])
})

async function installed(t, desktop = false) {
  const scratch = await mkdtemp(join(tmpdir(), 'dsh-dhp-test-'))
  t.after(() => rm(scratch, { recursive: true, force: true }))
  const directory = join(scratch, 'installation with spaces')
  const dshHome = join(scratch, 'home')
  await mkdir(join(directory, 'bin'), { recursive: true })
  await mkdir(join(dshHome, 'profiles/web'), { recursive: true })
  await writeFile(join(directory, 'bootstrap-state.json'), JSON.stringify({
    owner: 'shamcleren/dsh-plugin/bootstrap-v1', schemaVersion: 2, status: 'ready', dshHome, desktop,
  }))
  await writeFile(join(directory, 'bin/dsh'), '#!/bin/sh\nexit 0\n', { mode: 0o700 })
  if (desktop) {
    await mkdir(join(directory, 'DeepSeek Harness.app'), { recursive: true })
    await writeFile(join(directory, 'native-app.json'), JSON.stringify({
      app: 'DeepSeek Harness.app', servicePort: 3186, version: '0.2.9',
    }))
  }
  return { scratch, directory, dshHome }
}

test('start opens the recorded app and refuses a second start', async t => {
  const f = await installed(t, true)
  const calls = []
  await controlService({
    action: 'start', directory: f.directory, log() {},
    execute: async (...args) => { calls.push(args) },
    inspect: async () => ({ stdout: '' }),
  })
  assert.deepEqual(calls[0].slice(0, 2), ['open', [join(f.directory, 'DeepSeek Harness.app')]])
  await assert.rejects(controlService({
    action: 'start', directory: f.directory, log() {},
    inspect: async () => ({
      stdout: '  88 ' + f.directory + '/runtime/node_modules/@deepseek-ai/dsh/lib/bin.js web\n',
    }),
  }), /already running/)
})

test('restart signals only this installation then starts Web detached', async t => {
  const f = await installed(t)
  const signals = [], spawned = []
  let live = true
  await controlService({
    action: 'restart', web: true, directory: f.directory, log() {}, waitMs: async () => {},
    inspect: async () => ({
      stdout: live ? '  91 ' + f.directory + '/runtime/node_modules/@deepseek-ai/dsh/lib/bin.js web\n' : '',
    }),
    kill(pid, signal) { signals.push({ pid, signal }); live = false },
    spawnProcess(command, args, options) {
      spawned.push({ command, args, options })
      return { unref() {} }
    },
  })
  assert.deepEqual(signals, [{ pid: 91, signal: 'SIGTERM' }])
  assert.equal(spawned[0].command, join(f.directory, 'bin/dsh'))
  assert.deepEqual(spawned[0].args, ['web', '--host', '127.0.0.1', '--port', '3080', '--no-open'])
  assert.equal(spawned[0].options.detached, true)
})

test('restart delegates to the running native app without killing the caller host', async t => {
  const f = await installed(t, true)
  const calls = [], signals = []
  await controlService({
    action: 'restart', directory: f.directory, log() {}, waitMs: async () => {},
    inspect: async () => ({ stdout: [
      '  90 ' + f.directory + '/DeepSeek Harness.app/Contents/MacOS/DeepSeekHarness',
      '  91 ' + f.directory + '/DeepSeek Harness.app/Contents/Resources/runtime/node_modules/@deepseek-ai/dsh/lib/bin.js',
    ].join('\n') }),
    kill(pid, signal) { signals.push({ pid, signal }); throw new Error('Restart killed its own host') },
    execute: async (...args) => { calls.push(args) },
  })
  assert.deepEqual(signals, [])
  assert.deepEqual(calls[0].slice(0, 2), ['open', [join(f.directory, 'DeepSeek Harness.app')]])
})

test('native restart refuses an installation update before signalling any process', async t => {
  const f = await installed(t, true)
  await writeFile(join(f.directory, '.bootstrap.lock'), 'fixture')
  await assert.rejects(controlService({
    action: 'restart', directory: f.directory, log() {}, waitMs: async () => {},
    inspect: async () => ({ stdout: '  90 ' + f.directory + '/DeepSeek Harness.app/Contents/MacOS/DeepSeekHarness' }),
    kill() { throw new Error('Restart stopped a process while installation was updating') },
    execute: async () => { throw new Error('Restart opened an app while installation was updating') },
  }), /Installation is updating/)
})

test('native restart uses the explicit control executable without reopening the window', async t => {
  const f = await installed(t, true)
  const controller = join(f.directory, 'DeepSeek Harness.app/Contents/MacOS/DeepSeekHarnessControl')
  await mkdir(join(f.directory, 'DeepSeek Harness.app/Contents/MacOS'), { recursive: true })
  await writeFile(controller, '#!/bin/sh\nexit 0\n', { mode: 0o700 })
  const calls = []
  await controlService({
    action: 'restart', directory: f.directory, log() {},
    inspect: async () => ({ stdout: '  90 ' + f.directory + '/DeepSeek Harness.app/Contents/MacOS/DeepSeekHarness' }),
    kill() { throw new Error('Restart must not stop its caller') },
    execute: async (...args) => { calls.push(args) },
  })
  assert.deepEqual(calls, [[controller, [], { cwd: f.directory }]])
})

test('native restart does not silently reopen an app that requires a missing control executable', async t => {
  const f = await installed(t, true)
  for (const version of ['0.2.10', '0.2.11', '0.2.12', undefined]) {
    await writeFile(join(f.directory, 'native-app.json'), JSON.stringify({ app: 'DeepSeek Harness.app', version }))
    await assert.rejects(controlService({
      action: 'restart', directory: f.directory, log() {},
      inspect: async () => ({ stdout: '  90 ' + f.directory + '/DeepSeek Harness.app/Contents/MacOS/DeepSeekHarness' }),
      kill() { throw new Error('Unexpected signal') },
      execute: async () => { throw new Error('Unexpected reopen') },
    }), /Update or rebuild the native App/)
  }
})

test('restart --web explicitly switches a running native installation to Web', async t => {
  const f = await installed(t, true)
  const signals = [], spawned = []
  let live = true
  await runDhp(['--dir', f.directory, 'restart', '--web'], {
    log() {}, waitMs: async () => {},
    inspect: async () => ({ stdout: live ? [
      '  90 ' + f.directory + '/DeepSeek Harness.app/Contents/MacOS/DeepSeekHarness',
      '  91 ' + f.directory + '/runtime/node_modules/@deepseek-ai/dsh/lib/bin.js web',
    ].join('\n') : '' }),
    kill(pid, signal) { signals.push({ pid, signal }); live = false },
    execute: async () => { throw new Error('--web reopened the native app') },
    spawnProcess(command, args, options) { spawned.push({ command, args, options }); return { unref() {} } },
  })
  assert.deepEqual(signals, [{ pid: 90, signal: 'SIGTERM' }, { pid: 91, signal: 'SIGTERM' }])
  assert.equal(spawned[0].command, join(f.directory, 'bin/dsh'))
  assert.deepEqual(spawned[0].args, ['web', '--host', '127.0.0.1', '--port', '3186', '--no-open'])
})

test('update reuses bootstrap while preserving a Web-only installation', async t => {
  const f = await installed(t)
  const repo = join(f.scratch, 'repository')
  await mkdir(join(repo, 'scripts'), { recursive: true })
  await writeFile(join(repo, 'scripts/bootstrap.mjs'), 'export {}\n')
  const calls = []
  await runDhp(['--dir', f.directory, 'update', '--rebuild'], {
    repo, execute: async (...args) => { calls.push(args) },
  })
  assert.equal(calls[0][0], process.execPath)
  assert.deepEqual(calls[0][1], [
    join(repo, 'scripts/bootstrap.mjs'), '--dir', f.directory, '--no-app', '--rebuild-app',
  ])
})

test('plugin exec runs the installed package bin with its DSH home', async t => {
  const f = await installed(t)
  const repo = join(f.scratch, 'repository')
  const packageName = '@shamcleren/dsh-security-scan'
  const packageRoot = join(f.dshHome, 'profiles/web/node_modules', packageName)
  await mkdir(join(packageRoot, 'lib'), { recursive: true })
  await mkdir(repo)
  await writeFile(join(repo, 'marketplace.json'), JSON.stringify({
    schemaVersion: 1,
    plugins: [{
      id: 'security-scan', package: packageName, version: '0.7.0',
      placement: 'after-web-app',
    }],
  }))
  await writeFile(join(f.dshHome, 'profiles/web/package.json'), JSON.stringify({
    dependencies: { [packageName]: '0.7.0' },
  }))
  await writeFile(join(packageRoot, 'package.json'), JSON.stringify({
    name: packageName, version: '0.7.0', bin: { 'dsh-security': 'lib/cli.js' },
  }))
  await writeFile(join(packageRoot, 'lib/cli.js'), 'console.log("scan")\n')
  const calls = []
  await executePlugin({
    plugin: 'security-scan', args: ['scan', '--target', '/tmp/project'],
    repo, directory: f.directory, execute: async (...args) => { calls.push(args) },
  })
  assert.equal(calls[0][0], process.execPath)
  assert.deepEqual(calls[0][1].slice(1), ['scan', '--target', '/tmp/project'])
  assert.equal(calls[0][2].env.DSH_HOME, f.dshHome)
})

test('plugin update --all with no installed catalog plugins does nothing', async t => {
  const f = await installed(t)
  const repo = join(f.scratch, 'repository')
  await mkdir(repo)
  await writeFile(join(repo, 'marketplace.json'), await readFile(join(repository, 'marketplace.json')))
  await writeFile(join(f.dshHome, 'profiles/web/package.json'), '{"dependencies":{}}')
  const calls = [], logs = []
  assert.equal(await runDhp(['--dir', f.directory, 'plugin', 'update', '--all'], {
    repo, execute: async (...args) => { calls.push(args) }, log: line => logs.push(line),
  }), 0)
  assert.equal(calls.length, 0)
  assert.match(logs.join('\n'), /No catalog plugins are installed/)
})

test('plugin update requires a name or --all', async t => {
  const f = await installed(t)
  await assert.rejects(runDhp(['--dir', f.directory, 'plugin', 'update'], { repo: f.scratch }), /plugin update/)
  await assert.rejects(runDhp(['--dir', f.directory, 'plugin', 'update', '--all', 'wechat'], { repo: f.scratch }), /plugin update --all/)
})

test('plugin exec requires an installed plugin with exactly one safe bin', async t => {
  const f = await installed(t)
  const repo = join(f.scratch, 'repository')
  await mkdir(repo)
  await writeFile(join(repo, 'marketplace.json'), await readFile(join(repository, 'marketplace.json')))
  await writeFile(join(f.dshHome, 'profiles/web/package.json'), '{"dependencies":{}}')
  await assert.rejects(executePlugin({
    plugin: 'security-scan', repo, directory: f.directory, execute: async () => {},
  }), /not installed/)
})
