import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { checkCredentials, lockDshHome, prepareHomeProfile, publishHomeProfile, recoverHomeProfile, discardHomeProfile } from '../home-compatibility.mjs'
import { releaseInfo } from '../bootstrap.mjs'
import { fakeInstall } from './installer-fixture.mjs'
const repo = fileURLToPath(new URL('../../', import.meta.url)), runtime = join(repo, 'runtime')
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-compat-')), home = join(root, 'home')
  await mkdir(home)
  t.after(() => rm(root, { recursive: true, force: true }))
  return { root, home }
}

test('the official provider reads existing versioned grants and refs without rewriting them', async t => {
  const { home } = await fixture(t)
  const contents = 'version: 1\nrecords:\n  llm-fixture/test:\n    kind: grant\n    payload: {refresh: fixture-only}\nrefs:\n  COMPAT_FIXTURE_KEY: fixture-ref\n'
  const path = join(home, '.credentials.yaml'); await writeFile(path, contents, { mode: 0o600 })
  await checkCredentials({ home, runtime, log() {} })
  const { Context } = await import('../../runtime/node_modules/@deepseek-ai/cordis/lib/index.js')
  const { default: LocalCredentials } = await import('../../runtime/node_modules/@deepseek-ai/dsh-credentials-local/lib/index.js')
  const { credentialRef, credentialKey } = await import('../../runtime/node_modules/@deepseek-ai/dsh-credentials/lib/index.js')
  const ctx = new Context()
  try {
    await ctx.plugin(LocalCredentials, { dshHome: home, watch: false })
    assert.equal((await ctx.credentials.resolve(credentialRef('COMPAT_FIXTURE_KEY'))).value, 'fixture-ref')
    assert.deepEqual(await ctx.credentials.readRecord(credentialKey('llm-fixture', 'test')), { kind: 'grant', payload: { refresh: 'fixture-only' } })
    assert.equal(await readFile(path, 'utf8'), contents)
  } finally { await ctx.fiber.dispose() }
})

test('old flat credentials are backed up once before the official provider migrates them', async t => {
  const { home } = await fixture(t), path = join(home, '.credentials.yaml')
  const contents = '# saved credential\nCOMPAT_FIXTURE_KEY: fixture-only\n'
  await writeFile(path, contents, { mode: 0o600 })
  const logs = []
  for (let i = 0; i < 2; i++) await checkCredentials({ home, runtime, log: value => logs.push(value) })
  const backups = await readdir(join(home, '.dhp-backups'))
  assert.equal(backups.length, 1)
  assert.equal(await readFile(join(home, '.dhp-backups', backups[0]), 'utf8'), contents)
  assert.equal((await stat(join(home, '.dhp-backups', backups[0]))).mode & 0o777, 0o600)
  assert.equal(logs.join().includes('fixture-only'), false)
  assert.equal(await readFile(path, 'utf8'), contents)
  const { Context } = await import('../../runtime/node_modules/@deepseek-ai/cordis/lib/index.js')
  const { default: LocalCredentials } = await import('../../runtime/node_modules/@deepseek-ai/dsh-credentials-local/lib/index.js')
  const ctx = new Context()
  try {
    await ctx.plugin(LocalCredentials, { dshHome: home, watch: false })
    assert.match(await readFile(path, 'utf8'), /^version: 1\n/m)
    assert.equal(await readFile(join(home, '.dhp-backups', backups[0]), 'utf8'), contents)
  } finally { await ctx.fiber.dispose() }
})

for (const contents of ['version: 9\nrecords: {}\n', 'version: 1\nrefs: {TOKEN: [must-not-print]}\n']) test('unsupported credentials fail without conversion or secret logging: ' + contents.slice(0, 10), async t => {
  const { home } = await fixture(t), path = join(home, '.credentials.yaml'); await writeFile(path, contents, { mode: 0o600 })
  await assert.rejects(checkCredentials({ home, runtime, log() {} }), error => /left unchanged/.test(error.message) && !error.message.includes('must-not-print'))
  assert.equal(await readFile(path, 'utf8'), contents)
  assert.deepEqual(await readdir(home), ['.credentials.yaml'])
})

test('shared homes serialize installers and do not follow a credential symlink', async t => {
  const { home, root } = await fixture(t), unlock = await lockDshHome(home)
  await assert.rejects(lockDshHome(home), /Another installer/)
  await unlock()
  await writeFile(join(root, 'outside'), 'COMPAT_FIXTURE_KEY: fixture\n')
  await symlink(join(root, 'outside'), join(home, '.credentials.yaml'))
  await assert.rejects(checkCredentials({ home, runtime }), /regular file/)
})

async function upgrade(t) {
  const f = await fixture(t), profile = join(f.home, 'profiles/web'), catalog = JSON.parse(await readFile(join(repo, 'marketplace.json')))
  const entry = catalog.plugins.find(item => item.id === 'wechat')
  await mkdir(join(profile, 'node_modules', entry.package), { recursive: true })
  await writeFile(join(profile, 'node_modules', entry.package, 'package.json'), JSON.stringify({ name: entry.package, version: '0.4.0', peerDependencies: { '@deepseek-ai/dsh-session': '0.1.0-rc.8' } }))
  const original = JSON.stringify({ name: 'existing-profile', dependencies: { [entry.package]: '0.4.0' }, dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', entry.package, '@deepseek-ai/dsh-web-app'] } } })
  await writeFile(join(profile, 'package.json'), original)
  await writeFile(join(profile, 'cordis.yml'), '- id: user-owned\n  disabled: true\n')
  const release = await releaseInfo(repo)
  const transaction = await prepareHomeProfile({ ...f, repo, runtime, release, nodeExecutable: process.execPath, env: { PATH: process.env.PATH }, execute: fakeInstall, log() {} })
  return { ...f, profile, original, transaction, release, entry }
}

test('compatible local plugins publish together and retain the old profile and user patch', async t => {
  const f = await upgrade(t)
  assert.equal(await readFile(join(f.profile, 'package.json'), 'utf8'), f.original)
  await publishHomeProfile(f.transaction)
  await recoverHomeProfile({ ...f, runtimeDigest: f.release.runtimeDigest, ready: true })
  assert.equal(JSON.parse(await readFile(join(f.profile, 'node_modules', f.entry.package, 'package.json'))).version, f.entry.version)
  assert.equal(await readFile(join(f.profile, 'cordis.yml'), 'utf8'), '- id: user-owned\n  disabled: true\n')
  const backups = await readdir(join(f.home, '.dhp-backups'))
  assert.equal(await readFile(join(f.home, '.dhp-backups', backups[0], 'package.json'), 'utf8'), f.original)
})

test('interrupted runtime publication restores the previous compatible profile', async t => {
  const f = await upgrade(t)
  await publishHomeProfile(f.transaction)
  await recoverHomeProfile({ ...f, runtimeDigest: 'old-runtime', ready: true })
  assert.equal(await readFile(join(f.profile, 'package.json'), 'utf8'), f.original)
  assert.equal(JSON.parse(await readFile(join(f.profile, 'node_modules', f.entry.package, 'package.json'))).version, '0.4.0')
})

test('edits during staging are rejected and not overwritten by cleanup', async t => {
  const f = await upgrade(t)
  await writeFile(join(f.profile, 'cordis.yml'), 'user edited this during install\n')
  await assert.rejects(publishHomeProfile(f.transaction), /changed during installation/)
  await discardHomeProfile(f.transaction)
  assert.equal(await readFile(join(f.profile, 'cordis.yml'), 'utf8'), 'user edited this during install\n')
})
