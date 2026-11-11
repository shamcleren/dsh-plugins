import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { fork, spawn } from 'node:child_process'
import { once } from 'node:events'
import { createServer } from 'node:net'
import { chmod, mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { acquireInstallerLock, inspectInstallerLock } from '../installer-lock.mjs'

async function fixture(t) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'dhp-installer-lock-')))
  t.after(() => rm(root, { recursive: true, force: true }))
  return { root, path: join(root, '.bootstrap.lock') }
}

test('live leases exclude concurrent writers and release is idempotent', async t => {
  const { path } = await fixture(t), unlock = await acquireInstallerLock(path)
  try {
    assert.deepEqual(await inspectInstallerLock(path), { status: 'alive', pid: process.pid })
    await assert.rejects(acquireInstallerLock(path), /Another installer/)
  } finally { await unlock() }
  await unlock()
  assert.deepEqual(await inspectInstallerLock(path), { status: 'absent' })
})

test('concurrent recovery preserves exactly one stale backup and admits one writer', async t => {
  const { root, path } = await fixture(t), original = '42\n'
  await writeFile(path, original, { mode: 0o600 })
  const results = await Promise.allSettled(Array.from({ length: 8 }, () => acquireInstallerLock(path, { probe: () => 'dead' })))
  const winners = results.filter(result => result.status === 'fulfilled')
  try {
    assert.equal(winners.length, 1)
    const backups = (await readdir(root)).filter(name => name.includes('.stale-'))
    assert.equal(backups.length, 1)
    assert.equal(await readFile(join(root, backups[0]), 'utf8'), original)
    assert.equal(await readFile(path, 'utf8'), process.pid + '\n')
    assert.ok(results.filter(result => result.status === 'rejected').every(result => /Another installer/.test(result.reason.message)))
  } finally { await Promise.all(winners.map(result => result.value())) }
})

for (const status of ['alive', 'unknown']) test('retains a legacy PID lock when its process is ' + status, async t => {
  const { path } = await fixture(t)
  await writeFile(path, '42\n', { mode: 0o600 })
  await assert.rejects(acquireInstallerLock(path, { probe: () => status }), /PID 42/)
  assert.equal(await readFile(path, 'utf8'), '42\n')
})

for (const content of ['', '0\n', '-1\n', '4294967296\n', 'fixture-secret-must-not-print', '1'.repeat(65)]) test('retains unverified lock content: length ' + content.length, async t => {
  const { path } = await fixture(t)
  await writeFile(path, content, { mode: 0o600 })
  await assert.rejects(acquireInstallerLock(path, { probe: () => 'dead' }), error => /Cannot verify/.test(error.message) && !error.message.includes('fixture-secret'))
  assert.equal(await readFile(path, 'utf8'), content)
  assert.deepEqual(await inspectInstallerLock(path), { status: 'unknown' })
})

test('does not follow lock symlinks or adopt non-private lock files', async t => {
  const { root, path } = await fixture(t), outside = join(root, 'outside')
  await writeFile(outside, '42\n', { mode: 0o600 }); await symlink(outside, path)
  await assert.rejects(acquireInstallerLock(path, { probe: () => 'dead' }), /Cannot verify/)
  assert.equal(await readFile(outside, 'utf8'), '42\n')
  await unlink(path); await writeFile(path, '42\n', { mode: 0o666 })
  await assert.rejects(acquireInstallerLock(path, { probe: () => 'dead' }), /Cannot verify/)
})

test('two processes racing to recover an exited owner admit only one writer', async t => {
  const { path } = await fixture(t), dead = spawn(process.execPath, ['-e', ''])
  await once(dead, 'close')
  await writeFile(path, dead.pid + '\n', { mode: 0o600 })
  const workers = Array.from({ length: 2 }, () => {
    const child = fork(fileURLToPath(new URL('./installer-lock.fixture.mjs', import.meta.url)), [path], { stdio: ['ignore', 'pipe', 'pipe', 'ipc'] })
    const exited = once(child, 'close')
    const ready = Promise.race([once(child, 'message'), exited.then(() => { throw new Error('Lock worker exited before ready') })])
    return { child, ready, exited }
  })
  const timeout = setTimeout(() => workers.forEach(({ child }) => child.kill('SIGKILL')), 15000)
  try {
    await Promise.all(workers.map(worker => worker.ready))
    const responses = workers.map(worker => Promise.race([once(worker.child, 'message'), worker.exited.then(() => { throw new Error('Lock worker exited before responding') })]))
    for (const worker of workers) worker.child.send('acquire')
    assert.deepEqual((await Promise.all(responses)).map(([value]) => value).sort(), ['blocked', 'locked'])
  } finally {
    for (const { child } of workers) if (child.connected) child.send('release', () => {})
    const outcomes = await Promise.all(workers.map(worker => worker.exited))
    clearTimeout(timeout)
    assert.ok(outcomes.every(([code]) => code === 0))
  }
})

test('an unrecognized local guard is retained and cannot trigger lock recovery', async t => {
  const { path } = await fixture(t), port = 10000 + createHash('sha256').update(path).digest().readUInt16BE(0) % 15000
  await writeFile(path, '42\n', { mode: 0o600 })
  const server = createServer(socket => socket.end('not-an-installer\n'))
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve) })
  try {
    await assert.rejects(acquireInstallerLock(path, { probe: () => 'dead' }), /guard is unavailable/)
    assert.equal(await readFile(path, 'utf8'), '42\n')
  } finally { await new Promise(resolve => server.close(resolve)) }
})

test('release never deletes a replacement lock', async t => {
  const { path } = await fixture(t), unlock = await acquireInstallerLock(path)
  await unlink(path); await writeFile(path, process.pid + '\n', { mode: 0o600 })
  await assert.rejects(unlock(), /ownership changed/)
  assert.equal(await readFile(path, 'utf8'), process.pid + '\n')
})

test('failed publication releases the OS lease so a repaired directory can be retried', { skip: process.getuid?.() === 0 }, async t => {
  const { root, path } = await fixture(t)
  await chmod(root, 0o500)
  try { await assert.rejects(acquireInstallerLock(path), error => error.code === 'EACCES' || error.code === 'EPERM') }
  finally { await chmod(root, 0o700) }
  const unlock = await acquireInstallerLock(path)
  await unlock()
  assert.deepEqual(await readdir(root), [])
})

test('different installation paths can share a guard hash slot without blocking each other', async t => {
  const { root } = await fixture(t), slots = new Map()
  let paths
  for (let index = 0; index < 1000; index++) {
    const path = join(root, 'candidate-' + index, '.bootstrap.lock')
    const slot = createHash('sha256').update(path).digest().readUInt16BE(0) % 15000
    if (slots.has(slot)) { paths = [slots.get(slot), path]; break }
    slots.set(slot, path)
  }
  assert.ok(paths)
  for (const path of paths) await mkdir(join(path, '..'), { recursive: true })
  const first = await acquireInstallerLock(paths[0])
  try { const second = await acquireInstallerLock(paths[1]); await second() }
  finally { await first() }
})
