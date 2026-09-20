/** Keyless handshake against the provider's actual pinned Codex binary. */
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtemp } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { createInterface } from 'node:readline'

const require = createRequire(import.meta.url)
const codex = join(dirname(require.resolve('@openai/codex/package.json')), 'bin/codex.js')
const scratch = await mkdtemp(join(tmpdir(), 'dsh-codex-handshake-'))
const child = spawn(process.execPath, [codex, 'app-server', '--stdio'], {
  cwd: scratch,
  env: { ...process.env, CODEX_HOME: scratch, OPENAI_API_KEY: '', CODEX_API_KEY: '' },
  stdio: ['pipe', 'pipe', 'pipe'],
})
const exited = new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', resolve) })
const lines = createInterface({ input: child.stdout })
let diagnostic = ''
child.stderr.on('data', chunk => { diagnostic = (diagnostic + chunk).slice(-3000) })
const pending = new Map()
lines.on('line', line => {
  try {
    const frame = JSON.parse(line)
    const request = pending.get(frame.id)
    if (request) { pending.delete(frame.id); request.resolve(frame) }
  } catch (error) {
    for (const request of pending.values()) request.reject(error)
  }
})
async function request(id, method, params) {
  let timer
  try {
    return await Promise.race([
      new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject })
        child.stdin.write(JSON.stringify({ id, method, params }) + '\n')
      }),
      exited.then(() => { throw new Error('Codex exited before ' + method + ': ' + diagnostic) }),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(method + ' timed out')), 15000) }),
    ])
  } finally { clearTimeout(timer); pending.delete(id) }
}
try {
  const response = await request(1, 'initialize', {
    clientInfo: { name: 'dsh_codex_controller_smoke', title: 'DSH Controller smoke', version: '0.1.0' },
    capabilities: { experimentalApi: false },
  })
  assert.equal(response.error, undefined)
  assert.equal(typeof response.result?.userAgent, 'string')
  child.stdin.write(JSON.stringify({ method: 'initialized', params: {} }) + '\n')
  const config = await request(2, 'config/read', { includeLayers: false })
  assert.equal(config.error, undefined)
  assert.equal(typeof config.result?.config, 'object')
  console.log('Pinned Codex app-server: initialize → initialized → config/read passed; no model turn started.')
} finally {
  lines.close()
  child.stdin.end()
  child.kill('SIGTERM')
  const kill = setTimeout(() => child.kill('SIGKILL'), 3000)
  try { await exited } finally { clearTimeout(kill) }
}
