/** Opt-in release smoke: install catalog tarballs into an isolated official Web profile. */
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { verifyProfilePeers } from './home-compatibility.mjs'
import { releaseArtifact } from './plugins.mjs'

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const runtime = resolve(process.argv[2] ?? join(repo, 'runtime'))
const scratch = await mkdtemp(join(tmpdir(), 'dsh-release-smoke-'))
const home = join(scratch, 'home'), ready = join(scratch, 'ready.json')
const cli = join(runtime, 'node_modules/@deepseek-ai/dsh/lib/bin.js')
const env = { HOME: home, DSH_HOME: home, PATH: dirname(process.execPath) + ':' + join(runtime, 'node_modules/.bin') + ':/usr/bin:/bin', npm_config_cache: join(scratch, 'npm-cache') }
let host, exited, output = ''
async function waitFor(check, description) {
  const deadline = Date.now() + 60000
  while (Date.now() < deadline) {
    if (host?.exitCode !== null && host?.exitCode !== undefined) throw new Error('Host exited: ' + output)
    const value = await check()
    if (value) return value
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  throw new Error('Timed out: ' + description + '\n' + output)
}
try {
  await mkdir(home)
  const catalog = JSON.parse(await readFile(join(repo, 'marketplace.json'), 'utf8'))
  for (const entry of catalog.plugins) await releaseArtifact(repo, entry)
  const installer = spawn(process.execPath, [cli, 'plugin', '--profile', 'web', '--config.ignore-scripts=true', 'add', ...catalog.plugins.map(entry => join(repo, entry.artifact.path)), '--save-exact'], { cwd: scratch, env, stdio: ['ignore', 'pipe', 'pipe'] })
  let installLog = ''
  for (const stream of [installer.stdout, installer.stderr]) stream.on('data', chunk => { installLog += chunk })
  const [code] = await once(installer, 'exit')
  assert.equal(code, 0, installLog)
  const profile = join(home, 'profiles/web')
  await verifyProfilePeers(profile, runtime)
  const manifestPath = join(profile, 'package.json')
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
  const before = catalog.plugins.filter(entry => entry.placement === 'before-web-app').map(entry => entry.package)
  const after = catalog.plugins.filter(entry => entry.placement !== 'before-web-app').map(entry => entry.package)
  manifest.dsh.profile.bundles = ['@deepseek-ai/dsh-base', ...before, '@deepseek-ai/dsh-web-app', ...after]
  await writeFile(manifestPath, JSON.stringify(manifest))
  const portProbe = createServer()
  await new Promise(resolve => portProbe.listen(0, '127.0.0.1', resolve))
  const port = portProbe.address().port
  await new Promise(resolve => portProbe.close(resolve))
  const probe = join(scratch, 'probe.mjs')
  await writeFile(probe, `import { writeFile } from 'node:fs/promises'; export const inject = ['connection', 'webServer', 'skills']; export async function apply(ctx) { await writeFile(${JSON.stringify(ready)}, JSON.stringify({wecomUnified: (await ctx.skills.list()).some(item => item.name === 'wecom-unified'), url: ctx.connection.authenticatedUrl('http://127.0.0.1:' + ctx.webServer.port)}), {mode: 0o600}); }`)
  // No external accounts, pet windows or search traffic in the fixture. Web Search's
  // protocol/transport lifecycle is exercised separately against its local mock server.
  await writeFile(join(profile, 'cordis.patch.yml'), `
- id: webserver
  config:
    port: ${port}
    host: 127.0.0.1
- id: aidev
  config:
    enabled: true
    spaceId: smoke
    baseUrl: https://aidev.example.invalid/openapi/
- id: desktop-pet
  config:
    enabled: false
- id: web-search
  disabled: true
- insert:
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
  host = spawn(process.execPath, [cli, '--profile', 'web'], { cwd: scratch, env, stdio: ['ignore', 'pipe', 'pipe'] })
  exited = once(host, 'exit')
  for (const stream of [host.stdout, host.stderr]) stream.on('data', chunk => { output += chunk })
  const info = await waitFor(async () => {
    try { return JSON.parse(await readFile(ready, 'utf8')) } catch (error) { if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error }
  }, 'probe activation')
  assert.equal(info.wecomUnified, true, 'bundled WeCom Skill activated')
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
    } else assert.equal(result.ok, true, channel + ': ' + body)
    console.log(channel + ' authenticated RPC: passed')
  }
  assert.doesNotMatch(output, /startup failed:|did not activate|patch: id is required/)
  // Configuration exceptions still abort alpha.2 before its optional-entry audit.
  // Mirror the deployment guard above; do not claim unguarded exceptions are contained.
  console.log('Catalog artifacts and peers: ' + catalog.plugins.length + ' passed')
  console.log('Missing MCP credential guarded + offline MCP contained: authenticated Web HTTP 200')
} finally {
  if (host && host.exitCode === null) { host.kill('SIGTERM'); await exited }
  await rm(scratch, { recursive: true, force: true })
}
