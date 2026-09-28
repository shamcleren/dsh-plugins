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

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const update = process.argv.includes('--update')
const startupOnly = process.argv.includes('--startup-only')
if (startupOnly && update) throw new Error('--startup-only cannot verify an update')
const desktopArg = process.argv.find(arg => arg.startsWith('--desktop-app='))
const desktopApp = desktopArg && resolve(desktopArg.slice('--desktop-app='.length))
if (desktopApp && update) throw new Error('Desktop compatibility and managed Web update are separate checks')
const previousRuntimeArg = process.argv.find(arg => arg.startsWith('--previous-runtime='))
if (update && !previousRuntimeArg) throw new Error('--update requires --previous-runtime=/path/to/old/runtime to install the old plugins with their compatible runtime')
const runtime = resolve(process.argv.slice(2).find(arg => arg !== '--update' && arg !== '--startup-only' && arg !== previousRuntimeArg && arg !== desktopArg) ?? join(repo, 'runtime'))
const previousRuntime = previousRuntimeArg ? resolve(previousRuntimeArg.slice('--previous-runtime='.length)) : runtime
const scratch = await mkdtemp(join(tmpdir(), 'dsh-release-smoke-'))
const home = join(scratch, 'home'), ready = join(scratch, 'ready.json')
const cli = join(runtime, 'node_modules/@deepseek-ai/dsh/lib/bin.js')
const env = { HOME: home, DSH_HOME: home, PATH: dirname(process.execPath) + ':' + join(runtime, 'node_modules/.bin') + ':' + (process.env.PATH ?? '/usr/bin:/bin'), npm_config_cache: join(scratch, 'npm-cache') }
let host, exited, inspectHost, output = ''
const desktopIssues = []
async function command(args, options = {}) {
  const child = spawn(process.execPath, args, { cwd: scratch, env, stdio: ['ignore', 'pipe', 'pipe'], ...options })
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
  const catalog = JSON.parse(await readFile(join(repo, 'marketplace.json'), 'utf8'))
  const hasAidev = catalog.plugins.some(entry => entry.id === 'aidev')
  env.DSH_SMOKE_ARTIFACT = join(repo, catalog.plugins.find(entry => entry.id === 'wecom-tools').artifact.path)
  for (const entry of catalog.plugins) await releaseArtifact(repo, entry)
  const previous = { aidev: '0.3.4', 'trusted-marketplace': '0.4.5', 'security-scan': '0.12.0', wechat: '0.5.5', 'wecom-aibot': '0.6.8', 'dsh-pet': '0.2.3', 'codex-controller': '0.3.2', 'desktop-share': '0.1.4', 'web-search': '0.1.1', 'wecom-tools': '0.2.2' }
  const artifacts = catalog.plugins.map(entry => join(repo, update && previous[entry.id]
    ? entry.artifact.path.replace(entry.version + '.tgz', previous[entry.id] + '.tgz') : entry.artifact.path))
  const installer = spawn(process.execPath, [join(previousRuntime, 'node_modules/@deepseek-ai/dsh/lib/bin.js'), 'plugin', '--profile', 'web', '--config.ignore-scripts=true', 'add', ...artifacts, '--save-exact'], { cwd: scratch, env, stdio: ['ignore', 'pipe', 'pipe'] })
  let installLog = ''
  for (const stream of [installer.stdout, installer.stderr]) stream.on('data', chunk => { installLog += chunk })
  const [code] = await once(installer, 'exit')
  assert.equal(code, 0, installLog)
  const profile = join(home, 'profiles', desktopApp ? 'desktop' : 'web')
  // Only the isolated fixture is relocated; the official CLI cannot mutate a live Desktop profile.
  if (desktopApp) await rename(join(home, 'profiles/web'), profile)
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
    assert.deepEqual(Object.keys(after.dependencies).sort(), Object.keys(before.dependencies).sort())
    for (const entry of catalog.plugins) {
      const installed = JSON.parse(await readFile(join(profile, 'node_modules', entry.package, 'package.json'), 'utf8'))
      assert.equal(installed.version, entry.version, entry.id + ': dhp update installed release')
    }
    assert.equal(await readFile(join(home, 'settings.yaml'), 'utf8'), settings)
    assert.match(await readFile(join(profile, 'cordis.patch.yml'), 'utf8'), /selectedDefault: dsh-security-audit/)
    const again = await command([join(repo, 'scripts/dhp.mjs'), '--dir', installation, 'update'])
    assert.match(again, /Already up to date/)
    console.log('dhp update: all 10 plugins retained, releases upgraded, settings preserved, repeat is a no-op')
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
  const dead = spawnSync(process.execPath, ['-e', ''], { env, stdio: 'ignore' })
  assert.equal(dead.status, 0)
  await mkdir(join(home, 'security-scan'), { recursive: true })
  await writeFile(join(home, 'security-scan/.tasks.lock'), dead.pid + '\n', { mode: 0o600 })
  const portProbe = createServer()
  await new Promise((resolve, reject) => { portProbe.once('error', reject); portProbe.listen(desktopApp ? 19387 : 0, '127.0.0.1', resolve) })
  const port = portProbe.address().port
  await new Promise(resolve => portProbe.close(resolve))
  await writeFile(join(home, 'settings.yaml'), 'desktop-pet:\n  petSize: 120\nsecurity-scan:\n  gitleaksPath: /nonexistent/legacy-gitleaks\n')
  const probe = join(scratch, 'probe.mjs')
  const requiredTools = ['security_record_repair_delivery', 'security_start_scan', 'security_scan_status', 'security_scan', 'security_audit', 'security_reports', 'security_read_evidence', 'security_review_report', 'codex_delegate', 'aidev_search', 'aidev_resource_list_installed', 'aidev_resource_install', 'aidev_resource_uninstall', 'aidev_knowledge_query', 'aidev_agent_detail', 'aidev_skill_sync', 'aidev_mcp_create', 'aidev_knowledgebase_manage', 'aidev_knowledge_upload', 'aidev_agent_manage'].filter(name => hasAidev || !name.startsWith('aidev_'))
  await writeFile(probe, `import { writeFile } from 'node:fs/promises'; export const inject = ['connection', 'webServer', 'skills', 'tools', 'llm']; export async function apply(ctx) { await writeFile(${JSON.stringify(ready)}, JSON.stringify({skills: (await ctx.skills.list()).map(item => item.name), missingTools: ${JSON.stringify(requiredTools)}.filter(name => !ctx.tools.get(name)), codexProvider: ctx.llm.listProviders().some(item => item.id === 'codex'), url: ctx.connection.authenticatedUrl('http://127.0.0.1:' + ctx.webServer.port)}), {mode: 0o600}); }`)
  // No external accounts, pet windows or search traffic in the fixture. Web Search's
  // protocol/transport lifecycle is exercised separately against its local mock server.
  await writeFile(join(profile, 'cordis.patch.yml'), `
${migratedPreset}
- id: webserver
  config:
    port: ${port}
    host: 127.0.0.1
${hasAidev ? `- id: aidev
  config:
    enabled: true
    spaceId: smoke
    baseUrl: https://aidev.example.invalid/openapi/` : ''}
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
  if (desktopApp) {
    const resources = join(desktopApp, 'Contents/Resources')
    const bundled = join(resources, 'app.asar/dsh')
    host = spawn(join(desktopApp, 'Contents/MacOS/DeepSeek Harness'), [
      '--expose-internals', join(bundled, 'node_modules/@deepseek-ai/dsh-desktop-host/lib/index.js'),
      bundled, profile, join(resources, 'runtime/primary-runtime'),
      join(resources, 'runtime/pnpm/bin/pnpm.mjs'), join(resources, 'runtime/bin'),
    ], { cwd: profile, env: { ...env, ELECTRON_RUN_AS_NODE: '1' }, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] })
  } else host = spawn(process.execPath, [cli, '--profile', 'web', '--no-open'], { cwd: scratch, env, stdio: ['ignore', 'pipe', 'pipe'] })
  exited = once(host, 'exit')
  for (const stream of [host.stdout, host.stderr]) stream.on('data', chunk => { output += chunk })
  const info = await waitFor(async () => {
    try { return JSON.parse(await readFile(ready, 'utf8')) } catch (error) { if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error }
  }, 'probe activation')
  assert.ok(info.skills.includes('wecom-unified'), 'bundled WeCom Skill activated')
  assert.ok(info.skills.includes('security-review'), 'security review Skill activated')
  assert.deepEqual(info.missingTools, [], 'all plugin tool capabilities registered')
  assert.equal(info.codexProvider, true, 'Codex model provider registered')
  console.log('Host capabilities: ' + requiredTools.length + ' tools, 2 bundled Skills and Codex model provider registered')
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
  assert.deepEqual(JSON.parse(upgradeBody).result, { ok: true, value: { forms: 6, presets: 2 } })
  console.log('Legacy settings imported; 6 live forms, revision conflicts, static-field protection and 2 presets passed')
  for (const channel of ['security-scan', 'trusted-marketplace', 'aidev', 'codex-controller']) {
    const response = await fetch(`http://127.0.0.1:${port}/${channel}/state`, { method: 'POST', headers: { cookie, origin: `http://127.0.0.1:${port}`, 'content-type': 'application/json' }, body: JSON.stringify({ type: 'client-request', rpcId: 'smoke', method: 'state', payload: channel === 'codex-controller' ? { sessionId: 'smoke' } : {} }), signal: AbortSignal.timeout(5000) })
    const body = await response.text()
    assert.equal(response.status, 200, channel + ': ' + body)
    const result = JSON.parse(body).result
    if (channel === 'aidev') {
      // This plugin exposes remote resource operations only. An unknown method
      // validates its real route/envelope without contacting an external account.
      assert.equal(result.ok, false)
      assert.equal(result.error.code, 'bad-request')
    } else {
      assert.equal(result.ok, true, channel + ': ' + body)
      if (channel === 'trusted-marketplace') assert.equal(result.value.ref, 'upgrade-fixture', 'marketplace reads the Profile live reference')
      if (desktopApp && channel === 'trusted-marketplace') {
        const installed = result.value.installed.filter(item => catalog.plugins.some(entry => entry.package === item.packageName))
        console.log('Official Desktop: marketplace sees ' + installed.length + ' of ' + catalog.plugins.length + ' installed catalog packages')
        if (installed.length !== catalog.plugins.length) desktopIssues.push('Marketplace does not target the active Desktop profile')
      }
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
  const mutation = await fetch(`http://127.0.0.1:${port}/smoke-upgrade/mutation`, {
    method: 'POST', headers: { cookie, origin: `http://127.0.0.1:${port}`, 'content-type': 'application/json' },
    body: JSON.stringify({ type: 'client-request', rpcId: 'mutation', method: 'mutation', payload: {} }), signal: AbortSignal.timeout(120000),
  })
  const mutationText = await mutation.text()
  assert.equal(mutation.status, 200, mutationText)
  const mutationBody = JSON.parse(mutationText)
  assert.equal(mutationBody.result?.ok, true, JSON.stringify(mutationBody))
  assert.deepEqual(mutationBody.result.value, { profile: desktopApp ? 'desktop' : 'web', removed: true, installed: true, updated: true })
  console.log('Marketplace current-profile uninstall, reinstall and update: passed')
  assert.deepEqual(desktopIssues, [], 'Official Desktop replacement blockers')
  }
} catch (error) {
  console.error(output.replace(/([?&]token=)[^\s]+/g, '$1[redacted]'))
  throw error
} finally {
  if (host && host.exitCode === null) { host.kill('SIGTERM'); await exited }
  await rm(scratch, { recursive: true, force: true })
}
