/** Opt-in release smoke: install catalog tarballs into an isolated official Web profile. */
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { constants } from 'node:fs'
import { once } from 'node:events'
import { cp, mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { verifyProfilePeers } from './home-compatibility.mjs'
import { releaseArtifact } from './plugins.mjs'
import { releaseInfo } from './bootstrap.mjs'
import { smokeTarget } from './smoke-target.mjs'

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const update = process.argv.includes('--update')
const startupOnly = process.argv.includes('--startup-only')
if (startupOnly && update) throw new Error('--startup-only cannot verify an update')
const desktopArg = process.argv.find(arg => arg.startsWith('--desktop-app='))
const desktopApp = desktopArg && resolve(desktopArg.slice('--desktop-app='.length))
if (desktopApp && update) throw new Error('Desktop compatibility and managed Web update are separate checks')
const previousRepoArg = process.argv.find(arg => arg.startsWith('--previous-repo='))
const previousRuntimeArg = process.argv.find(arg => arg.startsWith('--previous-runtime='))
if (update && (!previousRuntimeArg || !previousRepoArg)) throw new Error('--update requires --previous-runtime=/path/to/old/runtime and --previous-repo=/path/to/old/release-checkout')
const runtimeOverride = process.argv.slice(2).find(arg => arg !== '--update' && arg !== '--startup-only' && arg !== previousRuntimeArg && arg !== previousRepoArg && arg !== desktopArg)
const target = await smokeTarget({ repo, desktopApp, runtimeOverride })
const { runtime, node: nodeExecutable, profileName } = target
const officialDesktop = target.kind === 'electron'
const previousRuntime = previousRuntimeArg ? resolve(previousRuntimeArg.slice('--previous-runtime='.length)) : runtime
const scratch = await mkdtemp(join(tmpdir(), 'dsh-release-smoke-'))
const home = join(scratch, 'home'), ready = join(scratch, 'ready.json')
const cli = join(runtime, 'node_modules/@deepseek-ai/dsh/lib/bin.js')
const env = { HOME: home, DSH_HOME: home, PATH: dirname(nodeExecutable) + ':' + join(runtime, 'node_modules/.bin') + ':' + (process.env.PATH ?? '/usr/bin:/bin'), npm_config_cache: join(scratch, 'npm-cache') }
let host, exited, inspectHost, output = ''
const desktopIssues = []
async function command(args, options = {}) {
  const child = spawn(nodeExecutable, args, { cwd: scratch, env, stdio: ['ignore', 'pipe', 'pipe'], ...options })
  let output = ''
  for (const stream of [child.stdout, child.stderr]) stream.on('data', chunk => { output += chunk })
  const [code] = await once(child, 'exit')
  assert.equal(code, 0, output)
  return output
}
async function waitFor(check, description) {
  const deadline = Date.now() + 60000
  while (Date.now() < deadline) {
    if (host?.exitCode !== null && host?.exitCode !== undefined) throw new Error('Host exited: ' + output)
    const value = await check()
    if (value) return value
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  throw new Error('Timed out: ' + description + '\n' + output.replace(/([?&]token=)[^\s]+/g, '$1[redacted]') + '\n' + (await inspectHost?.() ?? ''))
}
try {
  await mkdir(home)
  if (target.kind === 'native') console.log('Native macOS bundle: Node ' + (await command(['--version'])).trim() + ', official DSH ' + target.version + ', isolated Web profile (native window not automated)')
  const catalog = JSON.parse(await readFile(join(repo, 'marketplace.json'), 'utf8'))
  env.DSH_SMOKE_ARTIFACT = join(repo, catalog.plugins.find(entry => entry.id === 'wecom-tools').artifact.path)
  for (const entry of catalog.plugins) await releaseArtifact(repo, entry)
  const previousRepo = previousRepoArg ? resolve(previousRepoArg.slice('--previous-repo='.length)) : repo
  const previousCatalog = update ? JSON.parse(await readFile(join(previousRepo, 'marketplace.json'), 'utf8')) : catalog
  if (update) {
    const version = JSON.parse(await readFile(join(previousRuntime, 'node_modules/@deepseek-ai/dsh/package.json'), 'utf8')).version
    assert.ok(previousCatalog.plugins.every(entry => entry.dshVersion === version), 'Previous catalog must match the previous runtime')
    for (const entry of previousCatalog.plugins) await releaseArtifact(previousRepo, entry)
  }
  const artifacts = previousCatalog.plugins.map(entry => join(previousRepo, entry.artifact.path))
  if (update) {
    // A disposable repository-owned retirement fixture; never read the user's installed profile.
    const retired = join(scratch, 'retired-plugin')
    await mkdir(retired)
    await writeFile(join(retired, 'package.json'), JSON.stringify({
      name: '@shamcleren/dsh-codex-controller', version: '0.0.0', type: 'module', main: 'index.js',
      dsh: { bundle: { patch: './cordis.patch.yml' } },
      engines: { dsh: JSON.parse(await readFile(join(previousRuntime, 'node_modules/@deepseek-ai/dsh/package.json'))).version },
    }))
    await writeFile(join(retired, 'index.js'), 'export function apply() {}\n')
    await writeFile(join(retired, 'cordis.patch.yml'), "- insert:\n    - id: retired-codex-fixture\n      name: '@shamcleren/dsh-codex-controller'\n")
    artifacts.push(retired)
  }
  const installer = spawn(nodeExecutable, [join(previousRuntime, 'node_modules/@deepseek-ai/dsh/lib/bin.js'), 'plugin', '--profile', 'web', '--config.ignore-scripts=true', 'add', ...artifacts, '--save-exact'], { cwd: scratch, env, stdio: ['ignore', 'pipe', 'pipe'] })
  let installLog = ''
  for (const stream of [installer.stdout, installer.stderr]) stream.on('data', chunk => { installLog += chunk })
  const [code] = await once(installer, 'exit')
  assert.equal(code, 0, installLog)
  const profile = join(home, 'profiles', profileName)
  // Only the isolated fixture is relocated; the official CLI cannot mutate a live Desktop profile.
  if (officialDesktop) await rename(join(home, 'profiles/web'), profile)
  if (update) {
    // A real isolated installation: invoke the same CLI and transaction used by
    // users, without touching their home, installed app or running processes.
    const installation = join(scratch, 'installation'), release = await releaseInfo(repo)
    await mkdir(join(installation, 'bin'), { recursive: true })
    await cp(runtime, join(installation, 'runtime'), { recursive: true, verbatimSymlinks: true, mode: constants.COPYFILE_FICLONE })
    await writeFile(join(installation, 'bin/dsh'), '#!/bin/sh\nexit 1\n', { mode: 0o700 })
    await writeFile(join(installation, 'bootstrap-state.json'), JSON.stringify({
      owner: 'shamcleren/dsh-plugin/bootstrap-v1', schemaVersion: 2, status: 'ready', desktop: false,
      dshHome: home, dshVersion: release.dshVersion, runtimeDigest: release.runtimeDigest,
      launcherDigest: 'previous-launcher', appDigest: null,
    }))
    const settings = '# Isolated update fixture: preserve user configuration.\nagent-presets:\n  default: dsh-security-audit\n'
    await writeFile(join(home, 'settings.yaml'), settings)
    const before = JSON.parse(await readFile(join(profile, 'package.json'), 'utf8'))
    await command([join(repo, 'scripts/dhp.mjs'), '--dir', installation, 'update'])
    const after = JSON.parse(await readFile(join(profile, 'package.json'), 'utf8'))
    assert.ok(before.dependencies['@shamcleren/dsh-codex-controller'])
    assert.equal(after.dependencies['@shamcleren/dsh-codex-controller'], undefined)
    assert.deepEqual(Object.keys(after.dependencies).sort(), Object.keys(before.dependencies).filter(name => name !== '@shamcleren/dsh-codex-controller').sort())
    const retained = catalog.plugins.filter(entry => Object.hasOwn(before.dependencies, entry.package))
    const introduced = catalog.plugins.filter(entry => !Object.hasOwn(before.dependencies, entry.package))
    for (const entry of retained) {
      const installed = JSON.parse(await readFile(join(profile, 'node_modules', entry.package, 'package.json'), 'utf8'))
      assert.equal(installed.version, entry.version, entry.id + ': dhp update installed release')
    }
    assert.equal(await readFile(join(home, 'settings.yaml'), 'utf8'), settings)
    assert.match(await readFile(join(profile, 'cordis.patch.yml'), 'utf8'), /selectedDefault: dsh-security-audit/)
    const again = await command([join(repo, 'scripts/dhp.mjs'), '--dir', installation, 'update'])
    assert.match(again, /Already up to date/)
    for (const entry of introduced) assert.equal(after.dependencies[entry.package], undefined, entry.id + ': update must not install new optional plugins')
    console.log('dhp update: all ' + retained.length + ' installed plugins retained, releases upgraded, settings preserved, repeat is a no-op; new optional plugins were not installed')
    if (introduced.length) {
      await command([cli, 'plugin', '--profile', profileName, '--config.ignore-scripts=true', 'add', ...introduced.map(entry => join(repo, entry.artifact.path)), '--save-exact'])
      console.log('Explicitly installed ' + introduced.length + ' new optional plugins for the remaining isolated Host checks')
    }
  }
  await verifyProfilePeers(profile, runtime)
  let migratedPreset = ''
  if (update) {
    const yaml = createRequire(join(runtime, 'package.json'))('yaml')
    const patch = yaml.parseDocument(await readFile(join(profile, 'cordis.patch.yml'), 'utf8'))
    assert.ok(yaml.isSeq(patch.contents))
    // The official CLI may emit a flow sequence; normalize before adding fixture rows.
    patch.contents.flow = false
    migratedPreset = patch.toString()
  }
  const manifestPath = join(profile, 'package.json')
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
  const before = catalog.plugins.filter(entry => entry.placement === 'before-web-app').map(entry => entry.package)
  const after = catalog.plugins.filter(entry => entry.placement !== 'before-web-app').map(entry => entry.package)
  manifest.dsh.profile.bundles = ['@deepseek-ai/dsh-base', ...before, '@deepseek-ai/dsh-web-app', ...after]
  await writeFile(manifestPath, JSON.stringify(manifest))
  // Model an old Host crash using a real, reaped PID rather than a guessed PID.
  const dead = spawnSync(nodeExecutable, ['-e', ''], { env, stdio: 'ignore' })
  assert.equal(dead.status, 0)
  await mkdir(join(home, 'security-scan'), { recursive: true })
  await writeFile(join(home, 'security-scan/.tasks.lock'), dead.pid + '\n', { mode: 0o600 })
  const portProbe = createServer()
  await new Promise((resolve, reject) => { portProbe.once('error', reject); portProbe.listen(officialDesktop ? 19387 : 0, '127.0.0.1', resolve) })
  const port = portProbe.address().port
  await new Promise(resolve => portProbe.close(resolve))
  await writeFile(join(home, 'settings.yaml'), 'desktop-pet:\n  petSize: 120\nsecurity-scan:\n  gitleaksPath: /nonexistent/legacy-gitleaks\n')
  const probe = join(scratch, 'probe.mjs')
  const requiredTools = ['wechat_recipients', 'wechat_notify', 'wechat_notification_status', 'wechat_notification_cancel', 'dsh_security_scan_record_repair_delivery', 'dsh_security_scan_repair_rescan', 'dsh_security_scan_findings', 'dsh_security_scan_exclude_findings', 'dsh_security_scan_start', 'dsh_security_scan_status', 'dsh_security_scan_rules', 'dsh_security_scan_audit', 'dsh_security_scan_reports', 'dsh_security_scan_read_evidence', 'dsh_security_scan_review_report']
  await writeFile(probe, `import { writeFile } from 'node:fs/promises'; export const inject = ['connection', 'webServer', 'skills', 'tools', 'llm']; export function apply(ctx) { ctx.inject(['wechatPush'], async ctx => { await writeFile(${JSON.stringify(ready)}, JSON.stringify({skills: (await ctx.skills.list()).map(item => item.name), missingTools: ${JSON.stringify(requiredTools)}.filter(name => !ctx.tools.get(name)), codexProvider: ctx.llm.listProviders().some(item => item.id === 'codex'), url: ctx.connection.authenticatedUrl('http://127.0.0.1:' + ctx.webServer.port)}), {mode: 0o600}); }); }`)
  // No external accounts, pet windows or search traffic in the fixture. Web Search's
  // protocol/transport lifecycle is exercised separately against its local mock server.
  await writeFile(join(profile, 'cordis.patch.yml'), `
${migratedPreset}
- id: webserver
  config:
    port: ${port}
    host: 127.0.0.1
- id: desktop-pet
  config:
    enabled: false
- id: web-search
  disabled: true
- insert:
${startupOnly ? '' : `    - id: upgrade-probe
      name: ${JSON.stringify(join(repo, 'scripts/fixtures/dsh-upgrade-probe.mjs'))}`}
    - id: smoke-probe
      name: ${JSON.stringify(probe)}
    - id: smoke-mcp-missing-env
      disabled: !!js '!process.env.SMOKE_MCP_CREDENTIAL'
      name: '@deepseek-ai/dsh-mcp-client'
      config:
        serverName: missing_env
        transport: streamable-http
        url: http://127.0.0.1:1/mcp
        headers:
          Authorization: !!js '(() => { throw new Error("smoke missing credential") })()'
    - id: smoke-mcp-offline
      name: '@deepseek-ai/dsh-mcp-client'
      config:
        serverName: offline
        transport: streamable-http
        url: http://127.0.0.1:1/mcp
        failOnStartupError: false
        reconnect:
          enabled: false
`)
  if (officialDesktop) {
    const resources = join(desktopApp, 'Contents/Resources')
    const bundled = join(resources, 'app.asar/dsh')
    host = spawn(target.electron, [
      '--expose-internals', join(bundled, 'node_modules/@deepseek-ai/dsh-desktop-host/lib/index.js'),
      bundled, profile, join(resources, 'runtime/primary-runtime'),
      join(resources, 'runtime/pnpm/bin/pnpm.mjs'), join(resources, 'runtime/bin'),
    ], { cwd: profile, env: { ...env, ELECTRON_RUN_AS_NODE: '1' }, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] })
  } else host = spawn(nodeExecutable, [cli, '--profile', 'web', '--no-open'], { cwd: scratch, env, stdio: ['ignore', 'pipe', 'pipe'] })
  exited = once(host, 'exit')
  for (const stream of [host.stdout, host.stderr]) stream.on('data', chunk => { output += chunk })
  const info = await waitFor(async () => {
    try { return JSON.parse(await readFile(ready, 'utf8')) } catch (error) { if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error }
  }, 'probe activation')
  assert.ok(info.skills.includes('wecom-unified'), 'bundled WeCom Skill activated')
  assert.ok(info.skills.includes('dsh-security-review'), 'security review Skill activated')
  assert.deepEqual(info.missingTools, [], 'all plugin tool capabilities registered')
  assert.equal(info.codexProvider, false, 'removed Codex plugin does not register a model provider')
  console.log('Host capabilities: ' + requiredTools.length + ' tools and 2 bundled Skills registered; removed Codex provider absent')
  let cookie
  await waitFor(async () => {
    try {
      const response = await fetch(info.url, { redirect: 'manual', signal: AbortSignal.timeout(1000) })
      if (![302, 303, 307, 308].includes(response.status)) return false
      cookie = response.headers.getSetCookie().map(value => value.split(';')[0]).join('; ')
      const url = new URL(response.headers.get('location'), info.url)
      assert.equal(url.origin, new URL(info.url).origin)
      const page = await fetch(url, { headers: { cookie }, signal: AbortSignal.timeout(1000) })
      return page.status === 200 && /<html/i.test(await page.text())
    } catch { return false }
  }, 'authenticated Web page')
  if (catalog.plugins.some(entry => entry.id === 'github-workspace')) {
    const body = JSON.stringify({ type: 'client-request', rpcId: 'github-workspace-smoke', method: 'state', payload: {} })
    const endpoint = `http://127.0.0.1:${port}/github-workspace/state`
    const rejected = await fetch(endpoint, { method: 'POST', headers: { 'content-type': 'application/json' }, body, signal: AbortSignal.timeout(15000) })
    assert.equal(rejected.status, 401)
    const response = await fetch(endpoint, { method: 'POST', headers: { cookie, origin: `http://127.0.0.1:${port}`, 'content-type': 'application/json' }, body, signal: AbortSignal.timeout(15000) })
    assert.equal(response.status, 200)
    const result = (await response.json()).result
    assert.equal(result.ok, true)
    assert.equal(result.value.account, null, 'isolated Host must not access the user account')
    assert.deepEqual(result.value.projects, [])
    const crossOrigin = await fetch(endpoint, { method: 'POST', headers: { cookie, origin: 'https://external.invalid', 'content-type': 'application/json' }, body, signal: AbortSignal.timeout(5000) })
    assert.equal(crossOrigin.status, 403)
    console.log('GitHub Workspace packaged Host: authenticated RPC passed, anonymous and foreign-origin requests rejected; no live account used')
  }
  if (startupOnly) {
    const response = await fetch(`http://127.0.0.1:${port}/security-scan/state`, { method: 'POST', headers: { cookie, origin: `http://127.0.0.1:${port}`, 'content-type': 'application/json' }, body: JSON.stringify({ type: 'client-request', rpcId: 'startup', method: 'state', payload: {} }), signal: AbortSignal.timeout(5000) })
    assert.equal(response.status, 200)
    assert.equal((await response.json()).result.ok, true)
    console.log('Startup-only passed: authenticated Web page and security RPC; migration and marketplace mutations not tested')
  } else {
  inspectHost = async () => (await fetch(`http://127.0.0.1:${port}/smoke-upgrade/diagnostic`, { method: 'POST', headers: { cookie, origin: `http://127.0.0.1:${port}`, 'content-type': 'application/json' }, body: JSON.stringify({ type: 'client-request', rpcId: 'diagnostic', method: 'diagnostic', payload: {} }), signal: AbortSignal.timeout(3000) })).text()
  await waitFor(async () => {
    try { await readFile(join(home, 'settings.yaml.imported')); return (await readFile(join(profile, 'cordis.patch.yml'), 'utf8')).includes('/nonexistent/legacy-gitleaks') } catch (error) { if (error.code !== 'ENOENT') throw error }
  }, 'legacy settings import')
  const upgrade = await fetch(`http://127.0.0.1:${port}/smoke-upgrade/check`, { method: 'POST', headers: { cookie, origin: `http://127.0.0.1:${port}`, 'content-type': 'application/json' }, body: JSON.stringify({ type: 'client-request', rpcId: 'upgrade', method: 'check', payload: {} }), signal: AbortSignal.timeout(15000) })
  const upgradeBody = await upgrade.text()
  assert.equal(upgrade.status, 200, upgradeBody)
  assert.deepEqual(JSON.parse(upgradeBody).result, { ok: true, value: { forms: 5, presets: 1 } })
  console.log('Legacy settings imported; 5 live forms, revision conflicts, static-field protection and 1 preset passed')
  for (const channel of ['security-scan', 'trusted-marketplace']) {
    const response = await fetch(`http://127.0.0.1:${port}/${channel}/state`, { method: 'POST', headers: { cookie, origin: `http://127.0.0.1:${port}`, 'content-type': 'application/json' }, body: JSON.stringify({ type: 'client-request', rpcId: 'smoke', method: 'state', payload: {} }), signal: AbortSignal.timeout(5000) })
    const body = await response.text()
    assert.equal(response.status, 200, channel + ': ' + body)
    const result = JSON.parse(body).result

    assert.equal(result.ok, true, channel + ': ' + body)
      if (channel === 'trusted-marketplace') assert.equal(result.value.ref, 'upgrade-fixture', 'marketplace reads the Profile live reference')
      if (officialDesktop && channel === 'trusted-marketplace') {
        const installed = result.value.installed.filter(item => catalog.plugins.some(entry => entry.package === item.packageName))
        console.log('Official Desktop: marketplace sees ' + installed.length + ' of ' + catalog.plugins.length + ' installed catalog packages')
        if (installed.length !== catalog.plugins.length) desktopIssues.push('Marketplace does not target the active Desktop profile')
      }
    console.log(channel + ' authenticated RPC: passed')
  }
  // Exercise the installed security release through its authenticated public RPC.
  // Inventory mode avoids tool downloads and all model/external requests.
  const securityRpc = async (method, payload) => {
    const response = await fetch(`http://127.0.0.1:${port}/security-scan/${method}`, {
      method: 'POST', headers: { cookie, origin: `http://127.0.0.1:${port}`, 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'client-request', rpcId: crypto.randomUUID(), method, payload }), signal: AbortSignal.timeout(10000),
    })
    assert.equal(response.status, 200)
    const { result } = await response.json()
    assert.equal(result.ok, true, 'security ' + method + ': ' + JSON.stringify(result))
    return result.value
  }
  const scanTarget = join(scratch, 'scan-fixture')
  await mkdir(scanTarget); await writeFile(join(scanTarget, 'sample.py'), 'print("isolated smoke")\n')
  const task = await securityRpc('save', { config: { name: 'Release smoke', kind: 'local', target: scanTarget, scope: 'full', baseline: 'none', engine: 'inventory', dependencies: false, secrets: false, syncSession: true, agent: { enabled: false } } })
  const firstRun = await securityRpc('run', { id: task.id, revision: task.revision })
  const first = await waitFor(async () => (await securityRpc('state', {})).runs.find(run => run.id === firstRun.id && run.reportId), 'security inventory report')
  assert.ok(first.sessionId, 'real native observation session created')
  const actions = await securityRpc('reportActions', { id: first.reportId })
  assert.equal(actions.repairable, true); assert.equal(actions.findings.length, 0)
  const secondRun = await securityRpc('rescan', { id: first.reportId })
  const second = await waitFor(async () => (await securityRpc('state', {})).runs.find(run => run.id === secondRun.id && run.reportId), 'security rescan report')
  const comparison = (await securityRpc('reportActions', { id: second.reportId })).comparison
  assert.equal(comparison.previousId, first.reportId); assert.equal(comparison.comparable, false, 'inventory never proves repair')
  assert.deepEqual(second.config, first.config)
  console.log('Security release: native observation session, report actions and original-config rescan passed')
  assert.doesNotMatch(output, /startup failed:|did not activate|patch: id is required/)
  // Guard configuration expressions before mounting optional entries.
  // Mirror the deployment guard above; do not claim unguarded exceptions are contained.
  console.log('Catalog artifacts and peers: ' + catalog.plugins.length + ' passed')
  console.log('Missing MCP credential guarded + offline MCP contained: authenticated Web HTTP 200')
  for (const action of ['remove', 'install', 'update']) {
    const beforeUpdate = action === 'update' ? await readFile(join(profile, 'package.json')) : undefined
    const lockBeforeUpdate = action === 'update' ? await readFile(join(profile, 'pnpm-lock.yaml')) : undefined
    const mutation = await fetch(`http://127.0.0.1:${port}/smoke-upgrade/mutation`, {
      method: 'POST', headers: { cookie, origin: `http://127.0.0.1:${port}`, 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'client-request', rpcId: 'mutation', method: 'mutation', payload: { action } }), signal: AbortSignal.timeout(120000),
    })
    const mutationText = await mutation.text()
    assert.equal(mutation.status, 200, mutationText)
    const mutationBody = JSON.parse(mutationText)
    assert.equal(mutationBody.result?.ok, true, JSON.stringify(mutationBody))
    assert.deepEqual(mutationBody.result.value, { profile: profileName, action })
    await waitFor(async () => {
      const state = await fetch(`http://127.0.0.1:${port}/trusted-marketplace/state`, {
        method: 'POST', headers: { cookie, origin: `http://127.0.0.1:${port}`, 'content-type': 'application/json' },
        body: JSON.stringify({ type: 'client-request', rpcId: 'state', method: 'state', payload: {} }), signal: AbortSignal.timeout(5000),
      })
      if (state.status !== 200) return false
      const body = await state.json()
      if (!body.result?.ok) return false
      return body.result.value.installed.some(item => item.packageName === '@shamcleren/dsh-wecom-tools') === (action !== 'remove')
    }, 'marketplace state after ' + action)
    if (beforeUpdate) {
      assert.deepEqual(await readFile(join(profile, 'package.json')), beforeUpdate)
      assert.deepEqual(await readFile(join(profile, 'pnpm-lock.yaml')), lockBeforeUpdate)
    }
  }
  console.log('Marketplace current-profile uninstall and reinstall passed; installed update deferred without mutation')
  assert.deepEqual(desktopIssues, [], 'Official Desktop replacement blockers')
  }
} catch (error) {
  console.error(output.replace(/([?&]token=)[^\s]+/g, '$1[redacted]'))
  throw error
} finally {
  if (host && host.exitCode === null) { host.kill('SIGTERM'); await exited }
  await rm(scratch, { recursive: true, force: true })
}
