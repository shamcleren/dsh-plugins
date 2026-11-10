import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { pluginSourceDigest } from '../release-inputs.mjs'

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
