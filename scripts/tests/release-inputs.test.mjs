import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile, symlink, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { pluginSourceDigest, snapshotReleaseLock, readReleaseLock } from '../release-inputs.mjs'

test('release provenance changes with runtime source and lock inputs, not generated output', async t => {
  const repo = await mkdtemp(join(tmpdir(), 'dhp-release-inputs-')), plugin = join(repo, 'plugin')
  t.after(() => rm(repo, { recursive: true, force: true }))
  for (const directory of ['src', 'lib', 'node_modules', 'tests', 'skills/example']) await mkdir(join(plugin, directory), { recursive: true })
  for (const name of ['tsconfig.base.json', 'pnpm-lock.yaml']) await writeFile(join(repo, name), name)
  await writeFile(join(plugin, 'src/index.ts'), 'original')
  const original = await pluginSourceDigest(plugin, repo)
  await writeFile(join(plugin, 'lib/index.js'), 'generated'); await writeFile(join(plugin, 'node_modules/cache'), 'cache')
  assert.equal(await pluginSourceDigest(plugin, repo), original)
  await writeFile(join(plugin, 'src/index.ts'), 'changed')
  assert.notEqual(await pluginSourceDigest(plugin, repo), original)
  const beforeSkill = await pluginSourceDigest(plugin, repo)
  await writeFile(join(plugin, 'skills/example/SKILL.md'), 'runtime instructions')
  assert.notEqual(await pluginSourceDigest(plugin, repo), beforeSkill)
  const sourceChanged = await pluginSourceDigest(plugin, repo)
  await writeFile(join(repo, 'pnpm-lock.yaml'), 'different lock')
  assert.notEqual(await pluginSourceDigest(plugin, repo), sourceChanged)
})


test('retained release locks preserve old provenance without ignoring source or lock tampering', async t => {
  const repo = await mkdtemp(join(tmpdir(), 'dhp-release-lock-')), plugin = join(repo, 'plugin')
  t.after(() => rm(repo, { recursive: true, force: true }))
  await mkdir(plugin); await writeFile(join(plugin, 'index.js'), 'original')
  await writeFile(join(repo, 'tsconfig.base.json'), '{}'); await writeFile(join(repo, 'pnpm-lock.yaml'), 'old dependency graph')
  const before = await pluginSourceDigest(plugin, repo), lock = await snapshotReleaseLock(repo)
  assert.equal(await snapshotReleaseLock(repo), lock)
  await writeFile(join(repo, 'pnpm-lock.yaml'), 'new unrelated plugin dependency graph')
  assert.equal(await pluginSourceDigest(plugin, repo, lock), before)
  assert.notEqual(await pluginSourceDigest(plugin, repo), before)
  await writeFile(join(plugin, 'index.js'), 'modified source')
  assert.notEqual(await pluginSourceDigest(plugin, repo, lock), before)
  await assert.rejects(readReleaseLock(repo, '../pnpm-lock.yaml'), /Invalid release lock path/)
  await writeFile(join(repo, lock), 'tampered')
  await assert.rejects(readReleaseLock(repo, lock), /digest mismatch/)
  await rm(join(repo, lock)); await symlink(join(repo, 'pnpm-lock.yaml'), join(repo, lock))
  await assert.rejects(readReleaseLock(repo, lock), /Invalid release lock file/)
})


test('snapshot rejects linked archive directories before writing outside its repository', async t => {
  const repo = await mkdtemp(join(tmpdir(), 'dhp-release-link-')), outside = await mkdtemp(join(tmpdir(), 'dhp-release-outside-'))
  t.after(() => Promise.all([rm(repo, { recursive: true, force: true }), rm(outside, { recursive: true, force: true })]))
  await writeFile(join(repo, 'pnpm-lock.yaml'), 'fixture')
  await symlink(outside, join(repo, 'artifacts'))
  await assert.rejects(snapshotReleaseLock(repo), /Invalid release lock directory/)
  assert.deepEqual(await readdir(outside), [])
})
