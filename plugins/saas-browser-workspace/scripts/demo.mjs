import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdir, mkdtemp, readFile, writeFile, cp } from 'node:fs/promises'
import { appendFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const component = resolve(dirname(fileURLToPath(import.meta.url)), '..'), repo = resolve(component, '../..')
const runtime = join(repo, 'runtime/node_modules/@deepseek-ai/dsh')
if (JSON.parse(await readFile(join(runtime, 'package.json'))).version !== '0.2.1-rc.5') throw new Error('Requires official DSH 0.2.1-rc.5')
const siteFile = process.env.DSH_SAAS_SITE_CONFIG, modelFile = process.env.DSH_SAAS_MODEL_CONFIG
if (!siteFile || !modelFile) throw new Error('Set DSH_SAAS_SITE_CONFIG and DSH_SAAS_MODEL_CONFIG to private configuration files. This demo requires a real configured model.')
const model = JSON.parse(await readFile(modelFile, 'utf8'))
if (!model.provider || !model.model || !model.config?.baseURL || !model.config?.models?.some(m => m.id === model.model)) throw new Error('Invalid model route')
if (model.config.apiKey || model.config.headers) throw new Error('Use apiKeyEnv with the dedicated credential service; no inline keys or headers')
const scratch = await mkdtemp(join(tmpdir(), 'dsh-saas-agent-')), home = join(scratch, 'home'), ready = join(scratch, 'ready.json')
await mkdir(home, { mode: 0o700 }); await mkdir(join(scratch, 'workdir'))
await writeFile(join(scratch, 'demo.pid'), String(process.pid), { mode: 0o600 })
const cli = join(runtime, 'lib/bin.js')
const env = { ...process.env, DSH_HOME: home, DSH_DEMO_READY: ready, DSH_SAAS_STATE_DIR: join(scratch, 'execution-state'), DSH_DEMO_WORKDIR: join(scratch, 'workdir'), npm_config_cache: join(scratch, 'npm-cache') }
let host, log = ''
function capture(child) {
  for (const stream of [child.stdout, child.stderr]) stream.on('data', bytes => {
    const safe = bytes.toString().replace(/([?&]token=)[^\s"']+/g, '$1[redacted]')
    log += safe; appendFileSync(join(scratch, 'host.log'), safe, { mode: 0o600 })
  }); return child
}
async function command(executable, args, cwd) {
  log = ''; const child = capture(spawn(executable, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] }))
  const [code] = await once(child, 'exit'); if (code !== 0) throw new Error(log)
}
async function stop() { if (host && host.exitCode === null) { const done = once(host, 'exit'); host.kill('SIGTERM'); await done } }
try {
  console.log('Preparing real-agent demo: ' + scratch)
  const version = JSON.parse(await readFile(join(component, 'package.json'))).version
  const artifact = process.env.DSH_SAAS_ARTIFACT ? resolve(process.env.DSH_SAAS_ARTIFACT) : join(scratch, `shamcleren-dsh-saas-browser-workspace-${version}.tgz`)
  if (!process.env.DSH_SAAS_ARTIFACT) await command('pnpm', ['pack', '--pack-destination', scratch], component)
  await command(process.execPath, [cli, 'plugin', '--profile', 'web', '--config.ignore-scripts=true', 'add', artifact, '--save-exact'], scratch)
  const profile = join(home, 'profiles/web'), probe = join(profile, 'real-agent-probe.mjs')
  await cp(join(component, 'scripts/real-agent-probe.mjs'), probe)
  await writeFile(join(profile, 'cordis.patch.yml'), `
- id: webserver
  config:
    host: 127.0.0.1
    port: 0
- id: saas-browser-runtime
  config:
    enabled: true
    channel: chrome
    headless: true
    automationMode: standard
    snapshotDir: ${JSON.stringify(join(scratch, 'browser-artifacts'))}${process.env.DSH_SAAS_BROWSER_STATE ? '\n    storageStatePath: ' + JSON.stringify(resolve(process.env.DSH_SAAS_BROWSER_STATE)) : ''}
- id: llm-pi-ai
  config:
    providers: ${JSON.stringify({ [model.provider]: model.config })}
- insert:
    - id: saas-real-agent-demo
      name: ${JSON.stringify(probe)}
`)
  host = capture(spawn(process.execPath, [cli, '--profile', 'web', '--no-open'], { cwd: scratch, env, stdio: ['ignore', 'pipe', 'pipe'] }))
  const until = Date.now() + 90_000; let result
  while (Date.now() < until) {
    if (host.exitCode !== null || log.includes('entries did not activate')) throw new Error('Demo activation failed\n' + log)
    try { result = JSON.parse(await readFile(ready, 'utf8')); break } catch (e) { if (e.code !== 'ENOENT') throw e }
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  if (!result) throw new Error('Startup timed out\n' + log)
  console.log('Demo ready: ' + new URL(result.url).origin + '\nSession: ' + result.sessionId + '\nReal model: ' + result.provider + '/' + result.model + '\nPrivate access: ' + ready)
  if (process.env.DSH_DEMO_INFO) await writeFile(process.env.DSH_DEMO_INFO, JSON.stringify({ ...result, scratch, home }), { mode: 0o600 })
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => { void stop() })
  await once(host, 'exit')
} catch (error) { console.error(error.message); process.exitCode = 1 }
finally { await stop() }
