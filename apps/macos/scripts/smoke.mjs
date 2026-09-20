/** Install external tarballs into an isolated official runtime and check Web startup. */
import assert from 'node:assert/strict'
import { spawn, execFileSync } from 'node:child_process'
import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'

const [runtimeInput, ...packages] = process.argv.slice(2)
if (!runtimeInput || packages.length === 0) throw new Error('Usage: node scripts/smoke.mjs <installed-runtime-directory> <plugin.tgz>...')
const runtime = resolve(runtimeInput)
const entry = join(runtime, 'node_modules/@deepseek-ai/dsh/lib/bin.js')
const home = await mkdtemp(join(tmpdir(), 'dsh-official-smoke-'))
const env = { ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !/KEY|SECRET|TOKEN|PASSWORD|^NODE_OPTIONS$|^NODE_PATH$/i.test(key))), PATH: dirname(process.execPath) + ':' + join(runtime, 'node_modules/.bin') + ':' + process.env.PATH, DSH_HOME: home, DSH_AGENTS_HOME: join(home, 'agents'), DEEPSEEK_API_KEY: '', OPENAI_API_KEY: '' }
console.log('Isolated DSH home: ' + home)
execFileSync(process.execPath, [entry, 'plugin', '--profile', 'web', 'add', ...packages.map(path => resolve(path)), '--config.ignore-scripts=true'], { cwd: runtime, env, stdio: 'inherit', timeout: 180000 })
const manifest = JSON.parse(await readFile(join(home, 'profiles/web/package.json'), 'utf8'))
assert.ok(Object.keys(manifest.dependencies).length >= packages.length)
const child = spawn(process.execPath, [entry, '--profile', 'web', '--host', '127.0.0.1', '--port', '0', '--no-open'], { cwd: runtime, env, stdio: ['ignore', 'pipe', 'pipe'] })
const exited = new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', resolve) })
let timer
try {
  let hostOutput = ''
  const ready = new Promise(resolve => {
    const consume = chunk => {
      // Keep the authorization URL in memory; chunk boundaries can split its token.
      hostOutput = (hostOutput + chunk.toString()).slice(-20000)
      const url = hostOutput.match(/http:\/\/127\.0\.0\.1:\d+\/\?token=[A-Za-z0-9_-]+(?=\s)/)?.[0]
      if (url) resolve(url)
    }
    child.stdout.on('data', consume); child.stderr.on('data', consume)
  })
  const url = await Promise.race([ready, exited.then(code => { throw new Error('Host exited: ' + code + '\n' + hostOutput) }), new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Host startup timeout')), 30000) })])
  let response = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(10000) })
  let cookie = ''
  if ([302, 303, 307, 308].includes(response.status)) {
    const destination = new URL(response.headers.get('location'), url)
    assert.equal(destination.origin, new URL(url).origin)
    cookie = response.headers.getSetCookie().map(value => value.split(';')[0]).join('; ')
    response = await fetch(destination, { headers: { cookie }, signal: AbortSignal.timeout(10000) })
  }
  assert.equal(response.status, 200)
  assert.match(await response.text(), /<html/i)
  const packageNames = new Set(await Promise.all(packages.map(async path => JSON.parse(
    execFileSync('tar', ['-xOf', resolve(path), 'package/package.json'], { encoding: 'utf8' }),
  ).name)))
  for (const [packageName, channel] of [
    ['@shamcleren/dsh-security-scan', '/security-scan'],
    ['@shamcleren/dsh-plugin-marketplace', '/trusted-marketplace'],
  ]) {
    if (!packageNames.has(packageName)) continue
    const rpcId = randomUUID()
    const rpc = await fetch(new URL(channel + '/state', url), {
      method: 'POST', headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'client-request', rpcId, method: 'state', payload: {} }),
      signal: AbortSignal.timeout(10000),
    })
    assert.equal(rpc.status, 200, packageName + ' Host RPC route is unavailable')
    assert.equal((await rpc.json()).rpcId, rpcId)
  }
  console.log('Official Web profile HTTP smoke passed with ' + packages.length + ' external bundles.')
} finally {
  clearTimeout(timer)
  child.kill('SIGTERM')
  const kill = setTimeout(() => child.kill('SIGKILL'), 5000)
  try { await exited } finally { clearTimeout(kill) }
}
