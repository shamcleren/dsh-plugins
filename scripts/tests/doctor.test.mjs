import assert from 'node:assert/strict'
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { doctor } from '../doctor.mjs'
import { runDhp } from '../dhp.mjs'
import { treeDigest } from '../installation-integrity.mjs'

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'dhp-doctor-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const home = join(root, 'home'), runtime = join(root, 'runtime'), profile = join(home, 'profiles/web')
  await mkdir(profile, { recursive: true }); await mkdir(join(root, 'bin'))
  await mkdir(join(runtime, 'node_modules/@deepseek-ai/dsh/lib'), { recursive: true })
  await writeFile(join(runtime, 'package.json'), '{}')
  await symlink(new URL('../../runtime/node_modules/semver', import.meta.url).pathname, join(runtime, 'node_modules/semver'))
  await writeFile(join(runtime, 'node_modules/@deepseek-ai/dsh/package.json'), JSON.stringify({ version: '0.2.1-rc.5' }))
  for (const name of ['bin/dsh', 'bin/dhp', 'runtime/node_modules/@deepseek-ai/dsh/lib/bin.js']) await writeFile(join(root, name), '', { mode: 0o700 })
  await writeFile(join(root, 'bootstrap-state.json'), JSON.stringify({ owner: 'shamcleren/dsh-plugin/bootstrap-v1', schemaVersion: 2, status: 'ready', dshHome: home, desktop: false }))
  await writeFile(join(profile, 'package.json'), JSON.stringify({ dependencies: {} }))
  return { root, home, profile, directory: root, log() {}, inspect: async () => ({ stdout: '' }), probe: async () => true }
}

test('doctor and update --check are read-only and report all incompatible third-party plugins', async t => {
  const f = await fixture(t), lines = []
  await writeFile(join(f.profile, 'package.json'), JSON.stringify({ dependencies: { first: '1', second: '1' } }))
  for (const name of ['first', 'second']) {
    await mkdir(join(f.profile, 'node_modules', name), { recursive: true })
    await writeFile(join(f.profile, 'node_modules', name, 'package.json'), JSON.stringify({ engines: { dsh: '0.1.7-rc.2' } }))
  }
  const before = await treeDigest(f.home)
  const result = await doctor({ ...f, log: line => lines.push(line) })
  assert.equal(result.ok, false)
  assert.match(lines.join('\n'), /installed first/); assert.match(lines.join('\n'), /installed second/)
  assert.equal(await treeDigest(f.home), before)
  assert.equal(await runDhp(['--dir', f.root, 'update', '--check'], { ...f }), 1)
  assert.equal(await treeDigest(f.home), before)
})

test('doctor reports a healthy isolated installation and permission/port problems', async t => {
  const f = await fixture(t)
  assert.equal((await doctor(f)).ok, true)
  await writeFile(join(f.home, '.credentials.yaml'), 'private-value-not-for-output', { mode: 0o644 })
  await chmod(join(f.home, '.credentials.yaml'), 0o644)
  const lines = []
  assert.equal((await doctor({ ...f, probe: async () => false, log: line => lines.push(line) })).ok, false)
  assert.ok(lines.some(line => line.startsWith('CHECK Credentials')))
  assert.ok(lines.some(line => line.startsWith('CHECK Port')))
  assert.ok(!lines.join('\n').includes('private-value-not-for-output'))
})

test('doctor reports an uninitialized directory without claiming it', async t => {
  const f = await fixture(t)
  const missing = join(f.root, 'not-installed')
  assert.equal((await doctor({ ...f, directory: missing })).ok, false)
  await assert.rejects(readFile(join(missing, 'bootstrap-state.json')), { code: 'ENOENT' })
})

test('doctor distinguishes exited and live installer owners without changing either lock', async t => {
  const f = await fixture(t), dead = spawn(process.execPath, ['-e', ''])
  await once(dead, 'close')
  const bootstrap = join(f.root, '.bootstrap.lock'), shared = join(f.home, '.dhp-install.lock')
  await writeFile(bootstrap, dead.pid + '\n', { mode: 0o600 })
  await writeFile(shared, process.pid + '\n', { mode: 0o600 })
  const result = await doctor(f)
  assert.match(result.checks.find(item => item.name === 'Installer lock').detail, /has exited.*dhp update/)
  assert.match(result.checks.find(item => item.name === 'Shared-home lock').detail, /is running/)
  assert.equal(await readFile(bootstrap, 'utf8'), dead.pid + '\n')
  assert.equal(await readFile(shared, 'utf8'), process.pid + '\n')
})
