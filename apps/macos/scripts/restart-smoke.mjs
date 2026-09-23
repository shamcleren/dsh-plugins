/** Check internal CLI restart using a built native App and an isolated official Web profile. */
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { cp, mkdir, mkdtemp, readFile, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { listOwnedProcesses } from '../../../scripts/installation.mjs'
import { controlService } from '../../../scripts/service.mjs'

const capture = promisify(execFile)
const [appInput, cliInput, scenario] = process.argv.slice(2)
const recovery = scenario === '--recovery'
if (process.platform !== 'darwin' || !appInput || !cliInput) {
  throw new Error('Usage (macOS): node restart-smoke.mjs <built.app> <installed-dhp>')
}
const sourceApp = resolve(appInput), cli = resolve(cliInput)
const scratch = await realpath(await mkdtemp(join(tmpdir(), 'dsh-native-restart-')))
const root = join(scratch, 'installation with spaces'), home = join(scratch, 'home')
const app = join(root, 'DeepSeek Harness.app'), resources = join(app, 'Contents/Resources')
let initialized = false

async function waitFor(check, description, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const result = await check()
    if (result) return result
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  throw new Error('Timed out: ' + description)
}

async function optionalText(path) {
  try { return await readFile(path, 'utf8') } catch (error) {
    if (error.code === 'ENOENT') return ''
    throw error
  }
}

try {
  const portProbe = createServer()
  await new Promise(resolve => portProbe.listen(0, '127.0.0.1', resolve))
  const port = portProbe.address().port
  await new Promise(resolve => portProbe.close(resolve))
  await mkdir(join(app, 'Contents/MacOS'), { recursive: true })
  await mkdir(resources, { recursive: true })
  await mkdir(join(root, 'bin'), { recursive: true })
  await mkdir(join(home, 'profiles/web'), { recursive: true })
  await cp(join(sourceApp, 'Contents/MacOS/DeepSeekHarness'), join(app, 'Contents/MacOS/DeepSeekHarness'))
  await cp(join(sourceApp, 'Contents/MacOS/DeepSeekHarnessControl'), join(app, 'Contents/MacOS/DeepSeekHarnessControl'))
  // Reuse shipped, unmodified runtime files; all writable state belongs to this fixture.
  for (const name of ['node', 'runtime']) await symlink(join(sourceApp, 'Contents/Resources', name), join(resources, name))
  await cp(join(sourceApp, 'Contents/Resources/launcher'), join(resources, 'launcher'), { recursive: true })
  const info = JSON.parse((await capture('/usr/bin/plutil', ['-convert', 'json', '-o', '-', join(sourceApp, 'Contents/Info.plist')])).stdout)
  Object.assign(info, {
    CFBundleIdentifier: 'com.shamcleren.dsh.restart-test-' + randomUUID(),
    DSHInstallationRoot: root, DSHHome: home, DSHServicePort: port,
  })
  await writeFile(join(app, 'Contents/Info.plist'), JSON.stringify(info))
  await capture('/usr/bin/plutil', ['-convert', 'xml1', join(app, 'Contents/Info.plist')])
  await capture('/usr/bin/codesign', ['--force', '--sign', '-', '--timestamp=none', app])
  await writeFile(join(root, 'bootstrap-state.json'), JSON.stringify({
    owner: 'shamcleren/dsh-plugin/bootstrap-v1', schemaVersion: 2, status: 'ready', dshHome: home, desktop: true,
  }))
  await writeFile(join(root, 'native-app.json'), JSON.stringify({ app: 'DeepSeek Harness.app', version: info.CFBundleShortVersionString, servicePort: port }))
  await writeFile(join(root, 'bin/dsh'), '#!/bin/sh\nexit 0\n', { mode: 0o700 })
  initialized = true
  await writeFile(join(home, 'profiles/web/package.json'), JSON.stringify({
    name: 'restart-smoke-profile', private: true,
    dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'], patchReload: 'live' } },
  }))
  const probe = join(scratch, 'probe.mjs'), trigger = join(scratch, 'restart-request')
  const requestHost = async mode => {
    // Publish complete contents in one directory event, so the Host watcher
    // cannot consume an empty file before writeFile has finished writing it.
    await writeFile(trigger + '.tmp', mode)
    await rename(trigger + '.tmp', trigger)
  }
  const ready = join(scratch, 'probe-ready'), failed = join(scratch, 'probe-failed')
  const policy = join(scratch, 'native-policy.json')
  await writeFile(probe, `
import { watchFile, unwatchFile } from 'node:fs'
import { readFile, rename, unlink, writeFile } from 'node:fs/promises'
export const inject = ['subprocess', 'connection', 'webServer', 'systemPrompt']
export async function apply(ctx) {
  let requested = false
  const request = async () => {
    if (requested) return
    requested = true
    let mode
    try { mode = await readFile(${JSON.stringify(trigger)}, 'utf8'); await unlink(${JSON.stringify(trigger)}) } catch (error) {
      requested = false
      if (error.code === 'ENOENT') return
      throw error
    }
    if (mode === 'inspect') {
      const assembly = await ctx.systemPrompt.assemble()
      await writeFile(${JSON.stringify(policy)}, JSON.stringify(assembly.sections.filter(section => section.name === 'dsh-native-lifecycle')))
      requested = false
      return
    }
    // The same official subprocess owner used by AI shell tools handles teardown.
    const child = ctx.subprocess.spawn({
      argv: mode === 'terminate'
        ? ['/bin/sh', '-c', 'kill -TERM "$1"; sleep 2; exit 99', 'restart-smoke', String(process.pid)]
        : ['/bin/sh', '-c', 'exec "$1" --dir "$2" restart', 'restart-smoke', ${JSON.stringify(cli)}, ${JSON.stringify(root)}],
      cwd: ${JSON.stringify(root)}, graceMs: 1000,
      stdio: { stdin: 'ignore', stdout: 'inherit', stderr: 'inherit' },
    })
    await child.done
  }
  ctx.effect(() => {
    // Directory fs.watch may coalesce rapid unlink/recreate events on macOS.
    // Observe the durable outstanding request instead of relying on one event.
    const changed = () => { void request().catch(error => writeFile(${JSON.stringify(failed)}, error.message)) }
    watchFile(${JSON.stringify(trigger)}, { interval: 100 }, changed)
    return () => unwatchFile(${JSON.stringify(trigger)}, changed)
  })
  await writeFile(${JSON.stringify(ready + '.tmp')}, JSON.stringify({
    pid: process.pid, url: ctx.connection.authenticatedUrl('http://127.0.0.1:' + ctx.webServer.port),
  }), { mode: 0o600 })
  await rename(${JSON.stringify(ready + '.tmp')}, ${JSON.stringify(ready)})
}
`)
  await writeFile(join(home, 'profiles/web/cordis.patch.yml'), JSON.stringify([
    { insert: [{ id: 'restart-smoke', name: probe }] },
  ]))
  const otherProcesses = await listOwnedProcesses(dirname(sourceApp))
  await capture(cli, ['--dir', root, 'start'])
  const appPID = (await waitFor(async () => (await listOwnedProcesses(root))
    .find(item => item.command.includes('/Contents/MacOS/DeepSeekHarness')), 'fixture app starts')).pid
  const hostInfo = async () => {
    const text = await optionalText(ready)
    return text ? JSON.parse(text) : undefined
  }
  let hostPID = await waitFor(async () => (await hostInfo())?.pid, 'probe loads in official Host')
  const httpReady = async () => {
    try {
      const { url } = await hostInfo()
      let response = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(1000) })
      if ([302, 303, 307, 308].includes(response.status)) {
        const destination = new URL(response.headers.get('location'), url)
        assert.equal(destination.origin, new URL(url).origin)
        const cookie = response.headers.getSetCookie().map(value => value.split(';')[0]).join('; ')
        response = await fetch(destination, { headers: { cookie }, signal: AbortSignal.timeout(1000) })
      }
      return response.status === 200 && /<html/i.test(await response.text())
    } catch { return false }
  }
  await waitFor(httpReady, 'initial Web page responds')
  for (let cycle = 1; cycle <= 2; cycle++) {
    const previous = hostPID
    await requestHost(String(cycle))
    hostPID = await waitFor(async () => {
      const error = await optionalText(failed)
      assert.equal(error, '', error)
      const pid = (await hostInfo())?.pid
      return pid && pid !== previous ? pid : undefined
    }, 'internal restart replaces the Host')
    await waitFor(httpReady, 'Web page returns after restart')
    assert.ok((await listOwnedProcesses(root)).some(item => item.pid === appPID), 'native App survives tool teardown')
    assert.throws(() => process.kill(previous, 0), { code: 'ESRCH' }, 'old Host has exited')
    console.log(JSON.stringify({ cycle, appPID, oldHostPID: previous, newHostPID: hostPID, http: 200 }))
  }
  if (recovery) {
    const logPath = join(root, 'logs/launcher.log')
    const nativeReady = () => waitFor(async () => (await optionalText(logPath)).includes('Host ready pid=' + hostPID), 'native readiness callback commits')
    await nativeReady()
    await requestHost('inspect')
    const sections = JSON.parse(await waitFor(() => optionalText(policy), 'native policy reaches the assembled model context'))
    assert.equal(sections.length, 1)
    assert.ok(sections[0].text.includes(app), 'lifecycle command targets this fixture App')
    console.log('Native lifecycle policy is present in the official assembled prompt.')
    for (let attempt = 1; attempt <= 3; attempt++) {
      const previous = hostPID
      if (attempt === 2) process.kill(previous, 'SIGKILL')
      else await requestHost('terminate')
      hostPID = await waitFor(async () => {
        const pid = (await hostInfo())?.pid
        return pid && pid !== previous ? pid : undefined
      }, 'native App recovers after unexpected Host exit')
      await waitFor(httpReady, 'Web page returns after unexpected Host exit')
      await nativeReady()
      assert.ok((await listOwnedProcesses(root)).some(item => item.pid === appPID))
      assert.throws(() => process.kill(previous, 0), { code: 'ESRCH' })
      console.log(JSON.stringify({ scenario: attempt === 2 ? 'SIGKILL' : 'internal SIGTERM', attempt, appPID, oldHostPID: previous, newHostPID: hostPID, http: 200 }))
    }
    await requestHost('terminate')
    await waitFor(async () => (await optionalText(logPath)).includes('Automatic recovery stopped after repeated exits.'), 'recovery budget stops an exit loop')
    assert.equal((await listOwnedProcesses(root)).length, 1, 'only the native App remains after recovery budget exhaustion')
    console.log('Repeated ready/exit cycles stop after three recoveries.')
    // Explicit restart restores operation; stopping during a pending retry must cancel it.
    await capture(cli, ['--dir', root, 'restart'])
    const previous = hostPID
    hostPID = await waitFor(async () => {
      const pid = (await hostInfo())?.pid
      return pid && pid !== previous ? pid : undefined
    }, 'explicit restart recovers from budget exhaustion')
    await nativeReady()
    const beforeExitLog = (await optionalText(logPath)).length
    await requestHost('terminate')
    await waitFor(async () => (await optionalText(logPath)).slice(beforeExitLog).includes('Automatic Host recovery scheduled'), 'a retry is pending before stop')
    await controlService({ action: 'stop', directory: root, log() {} })
    assert.deepEqual(await listOwnedProcesses(root), [])
    console.log('Explicit stop removes the App and cancels its pending recovery.')

    const patchPath = join(home, 'profiles/web/cordis.patch.yml')
    const originalPatch = await readFile(patchPath, 'utf8')
    let offset = (await optionalText(logPath)).length
    await writeFile(patchPath, JSON.stringify([{ insert: [{ id: 'invalid-startup', name: './missing-plugin.mjs' }] }]))
    await capture(cli, ['--dir', root, 'start'])
    await waitFor(async () => (await optionalText(logPath)).slice(offset).includes('The server exited before becoming ready.'), 'startup failures remain stopped')
    assert.equal((await listOwnedProcesses(root)).length, 1)
    assert.ok(!(await optionalText(logPath)).slice(offset).includes('Automatic Host recovery scheduled'))
    await controlService({ action: 'stop', directory: root, log() {} })
    await writeFile(patchPath, originalPatch)
    console.log('Invalid startup stays stopped without a recovery loop.')

    const startHealthy = async () => {
      const previous = hostPID
      await capture(cli, ['--dir', root, 'start'])
      hostPID = await waitFor(async () => {
        const pid = (await hostInfo())?.pid
        return pid && pid !== previous ? pid : undefined
      }, 'fresh fixture Host starts')
      await waitFor(httpReady, 'fresh fixture Web page responds')
      await nativeReady()
    }
    await startHealthy()
    const lockPath = join(root, '.bootstrap.lock')
    await writeFile(lockPath, 'fixture update owner')
    offset = (await optionalText(logPath)).length
    await requestHost('terminate')
    await waitFor(async () => (await optionalText(logPath)).slice(offset).includes('Host startup failed: Installation is updating.'), 'recovery respects installation updates')
    assert.equal((await listOwnedProcesses(root)).length, 1)
    assert.equal(await readFile(lockPath, 'utf8'), 'fixture update owner')
    await rm(lockPath)
    await controlService({ action: 'stop', directory: root, log() {} })
    console.log('Recovery preserves and respects the installation update lock.')

    await startHealthy()
    offset = (await optionalText(logPath)).length
    await requestHost('terminate')
    await waitFor(async () => (await optionalText(logPath)).slice(offset).includes('Automatic Host recovery scheduled'), 'Host has exited before another owner binds')
    // WebKit may reconnect while the foreign owner holds the port. Close its
    // test-owned sockets so listener cleanup cannot wait on an idle connection.
    const foreignListener = createServer(socket => socket.destroy())
    try {
      await new Promise((resolve, reject) => { foreignListener.once('error', reject); foreignListener.listen(port, '127.0.0.1', resolve) })
      await waitFor(async () => (await optionalText(logPath)).slice(offset).includes('is used by another process, which was left running'), 'recovery refuses a foreign listener')
      assert.ok(foreignListener.listening)
      assert.equal((await listOwnedProcesses(root)).length, 1)
      console.log('Recovery leaves a foreign port owner running.')
    } finally {
      await new Promise(resolve => foreignListener.close(resolve))
    }
    await controlService({ action: 'stop', directory: root, log() {} })
  }
  for (const item of otherProcesses) process.kill(item.pid, 0)
  console.log('Internal restart passed twice; the source installation was untouched.')
} catch (error) {
  const log = await optionalText(join(root, 'logs/launcher.log'))
  console.error(log.slice(-12000))
  throw error
} finally {
  if (initialized) await controlService({ action: 'stop', directory: root, log() {} })
  await rm(scratch, { recursive: true, force: true })
}
