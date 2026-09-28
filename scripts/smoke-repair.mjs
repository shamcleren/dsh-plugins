/** Opt-in, networked smoke through real init/update/launch entry points in a private home. */
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const repo = fileURLToPath(new URL('../', import.meta.url))
const scratch = await mkdtemp(join(tmpdir(), 'dsh-repair-smoke-'))
const installation = join(scratch, 'installation'), home = join(scratch, 'home')
const privateNode = process.argv.includes('--private-node')
const env = { HOME: home, DSH_HOME: join(home, '.dsh'),
  PATH: (privateNode ? '' : dirname(process.execPath) + ':') + '/usr/bin:/bin:/usr/sbin:/sbin',
  npm_config_cache: join(scratch, 'npm-cache') }
let host, hostDone, hostOutput = ''
async function command(executable, args) {
  const child = spawn(executable, args, { cwd: repo, env, stdio: ['ignore', 'pipe', 'pipe'] })
  let output = ''
  for (const stream of [child.stdout, child.stderr]) stream.on('data', chunk => { output += chunk })
  const done = once(child, 'close')
  const timeout = setTimeout(() => child.kill('SIGTERM'), 180000)
  try { const [code] = await done; assert.equal(code, 0, output); return output }
  finally { clearTimeout(timeout) }
}
try {
  await mkdir(home)
  console.log('Installing the locked runtime through make init in an isolated home…')
  await command('/usr/bin/make', ['init', 'DIR=' + installation, 'WEB_ONLY=1'])
  const settings = join(env.DSH_HOME, 'settings.yaml'), sentinel = '# repair smoke: preserve this configuration\n'
  await writeFile(settings, sentinel)
  assert.match(await command('/usr/bin/make', ['init', 'DIR=' + installation]), /Already up to date/)
  const marker = join(installation, 'bootstrap-state.json')
  assert.equal(JSON.parse(await readFile(marker)).desktop, false)
  console.log('Repeated make init preserves Web-only configuration and is a no-op.')

  await rm(join(installation, 'bin/dsh'))
  await rm(join(installation, 'runtime/node_modules/@deepseek-ai/dsh/lib/bin.js'))
  if (privateNode) await rm(join(installation, 'node/bin/node'))
  await command(join(installation, 'bin/dhp'), ['update'])
  assert.match(await command(join(installation, 'bin/dsh'), ['--version']), /0\.1\./)
  const repaired = await readFile(marker)
  assert.match(await command(join(installation, 'bin/dhp'), ['update']), /Already up to date/)
  assert.deepEqual(await readFile(marker), repaired)
  assert.equal(await readFile(settings, 'utf8'), sentinel)
  console.log('dhp update restores the missing runtime and launcher, then becomes a no-op.')

  const profile = join(env.DSH_HOME, 'profiles/web'), ready = join(scratch, 'ready.json')
  await mkdir(profile, { recursive: true })
  await writeFile(join(profile, 'package.json'), JSON.stringify({ name: 'repair-smoke', private: true,
    dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'] } } }))
  const probe = join(scratch, 'probe.mjs')
  await writeFile(probe, `import { writeFile, rename } from 'node:fs/promises';
export const inject = ['connection', 'webServer'];
export async function apply(ctx) {
  await writeFile(${JSON.stringify(ready + '.next')}, JSON.stringify({ url: ctx.connection.authenticatedUrl('http://127.0.0.1:' + ctx.webServer.port) }), { mode: 0o600 });
  await rename(${JSON.stringify(ready + '.next')}, ${JSON.stringify(ready)});
}`)
  await writeFile(join(profile, 'cordis.patch.yml'), `- insert:\n    - id: repair-smoke-probe\n      name: ${JSON.stringify(probe)}\n`)
  host = spawn(join(installation, 'bin/dsh'), ['web', '--host', '127.0.0.1', '--port', '0', '--no-open'], { cwd: scratch, env, stdio: ['ignore', 'pipe', 'pipe'] })
  hostDone = once(host, 'close')
  for (const stream of [host.stdout, host.stderr]) stream.on('data', chunk => { hostOutput += chunk })
  const deadline = Date.now() + 60000
  let info
  while (!info && Date.now() < deadline) {
    assert.equal(host.exitCode, null, hostOutput)
    try { info = JSON.parse(await readFile(ready, 'utf8')) }
    catch (error) { if (error.code !== 'ENOENT') throw error }
    if (!info) await new Promise(resolve => setTimeout(resolve, 100))
  }
  assert.ok(info, 'Host did not become ready: ' + hostOutput)
  const response = await fetch(info.url, { redirect: 'manual', signal: AbortSignal.timeout(5000) })
  assert.ok([302, 303, 307, 308].includes(response.status))
  const cookie = response.headers.getSetCookie().map(value => value.split(';')[0]).join('; ')
  const url = new URL(response.headers.get('location'), info.url)
  assert.equal(url.origin, new URL(info.url).origin)
  const page = await fetch(url, { headers: { cookie }, signal: AbortSignal.timeout(5000) })
  assert.equal(page.status, 200)
  assert.match(await page.text(), /<html/i)
  host.kill('SIGTERM'); await hostDone; host = undefined
  assert.match(await command(join(installation, 'bin/dhp'), ['update']), /Already up to date/)
  assert.equal(await readFile(settings, 'utf8'), sentinel)
  console.log('Repaired launcher serves authenticated Web UI; normal Host startup does not trigger another repair.')
} finally {
  if (host) { host.kill('SIGTERM'); await hostDone }
  await rm(scratch, { recursive: true, force: true })
}
