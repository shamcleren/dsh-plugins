import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { execFileSync } from 'node:child_process'
import { releasePlugin } from '../release-plugin.mjs'
import { releaseArtifact } from '../plugins.mjs'

test('an initial release is built, verified and appended without a fake published version', async t => {
  const repo = await mkdtemp(join(tmpdir(), 'dhp-initial-release-')), plugin = join(repo, 'plugins/fixture')
  t.after(() => rm(repo, { recursive: true, force: true }))
  await mkdir(plugin, { recursive: true }); await mkdir(join(repo, 'artifacts'))
  for (const name of ['tsconfig.base.json', 'pnpm-lock.yaml']) await writeFile(join(repo, name), 'fixture')
  await writeFile(join(repo, 'marketplace.json'), JSON.stringify({ schemaVersion: 1, plugins: [] }))
  await writeFile(join(plugin, 'package.json'), JSON.stringify({ name: '@fixture/im', version: '0.1.0', type: 'module', files: ['lib', 'cordis.patch.yml'], dsh: { bundle: { patch: './cordis.patch.yml' } }, scripts: { build: 'node build.mjs' } }))
  await writeFile(join(plugin, 'cordis.patch.yml'), '[]\n')
  await writeFile(join(plugin, 'build.mjs'), "import {mkdir,writeFile} from 'node:fs/promises'; await mkdir('lib',{recursive:true}); await writeFile('lib/index.js','export function apply() {}\\n')\n")
  // Prepare the fixture's own dependency lock before the release input is frozen.
  execFileSync('pnpm', ['install', '--ignore-scripts', '--offline'], { cwd: plugin, stdio: 'pipe' })
  const initial = { id: 'fixture-im', package: '@fixture/im', name: 'Fixture IM', description: 'Isolated release fixture', dshVersion: '0.2.1-rc.5', placement: 'before-web-app' }
  const entry = await releasePlugin('fixture-im', repo, { initial })
  assert.equal(entry.version, '0.1.0'); await releaseArtifact(repo, entry)
  const published = await readFile(join(repo, 'marketplace.json'), 'utf8')
  assert.deepEqual(JSON.parse(published).plugins, [entry])
  await assert.rejects(releasePlugin('fixture-im', repo, { initial }), /Invalid initial/)
  await assert.rejects(releasePlugin('fixture-im', repo), /Increment/)
  assert.equal(await readFile(join(repo, 'marketplace.json'), 'utf8'), published)
})
