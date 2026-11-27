import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { parseSyncArgs, syncDshVersion } from '../sync-dsh-version.mjs'

const repository = fileURLToPath(new URL('../../', import.meta.url))

test('parseSyncArgs enforces exact versions and flag combinations', () => {
  assert.deepEqual(parseSyncArgs([]), { check: true, to: undefined, write: false, includeCatalog: false })
  assert.deepEqual(parseSyncArgs(['--to', '0.2.2', '--write']), { check: false, to: '0.2.2', write: true, includeCatalog: false })
  assert.throws(() => parseSyncArgs(['--to', '^0.2.2']), /exact release/)
  assert.throws(() => parseSyncArgs(['--check', '--write']), /cannot be combined/)
  assert.throws(() => parseSyncArgs(['--include-catalog']), /requires --to/)
})

test('repository DSH version pins are fully synchronized', async () => {
  const result = await syncDshVersion(repository)
  assert.equal(result.mismatches.length, 0, JSON.stringify(result.mismatches.slice(0, 5)))
  assert.ok(result.checkedPins > 100)
})

test('syncDshVersion detects drift and updates manifests cleanly in an isolated fixture', async t => {
  const root = await mkdtemp(join(tmpdir(), 'dhp-sync-dsh-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  await mkdir(join(root, 'runtime'), { recursive: true })
  await mkdir(join(root, 'plugins/demo'), { recursive: true })

  await writeFile(join(root, 'runtime/package.json'), JSON.stringify({
    name: 'dsh-official-runtime',
    dependencies: { '@deepseek-ai/dsh': '0.2.1-rc.5' },
  }, null, 2) + '\n')
  await writeFile(join(root, 'plugins/demo/package.json'), JSON.stringify({
    name: '@shamcleren/dsh-demo',
    version: '0.1.0',
    engines: { dsh: '0.2.1-rc.4' },
    peerDependencies: { '@deepseek-ai/dsh-tools': '0.2.1-rc.5', '@deepseek-ai/cordis': '~4.0.5' },
    devDependencies: { '@deepseek-ai/dsh-session': '0.2.1-rc.4' },
  }, null, 2) + '\n')
  await writeFile(join(root, 'pnpm-workspace.yaml'), [
    'packages:',
    '  - plugins/*',
    'minimumReleaseAgeExclude:',
    "  - '@deepseek-ai/dsh@0.2.1-rc.5'",
    "  - '@deepseek-ai/dsh-tools@0.2.1-rc.4'",
    '',
  ].join('\n'))
  await writeFile(join(root, 'marketplace.json'), JSON.stringify({
    schemaVersion: 1,
    plugins: [{ id: 'demo', package: '@shamcleren/dsh-demo', version: '0.1.0', dshVersion: '0.2.1-rc.5' }],
  }, null, 2) + '\n')

  const audit = await syncDshVersion(root)
  assert.equal(audit.mismatches.length, 3)

  // Dry run must leave files untouched.
  const dry = await syncDshVersion(root, { targetVersion: '0.2.2', includeCatalog: true, write: false })
  assert.ok(dry.mismatches.length >= 6)
  assert.equal(dry.updatedFiles.length, 0)
  assert.equal(JSON.parse(await readFile(join(root, 'runtime/package.json'), 'utf8')).dependencies['@deepseek-ai/dsh'], '0.2.1-rc.5')

  // Write mode updates all pins and passes subsequent check.
  const applied = await syncDshVersion(root, { targetVersion: '0.2.2', includeCatalog: true, write: true })
  assert.deepEqual(applied.updatedFiles.sort(), ['marketplace.json', 'plugins/demo/package.json', 'pnpm-workspace.yaml', 'runtime/package.json'])
  const after = await syncDshVersion(root)
  assert.equal(after.targetVersion, '0.2.2')
  assert.equal(after.mismatches.length, 0)
  const pluginManifest = JSON.parse(await readFile(join(root, 'plugins/demo/package.json'), 'utf8'))
  assert.equal(pluginManifest.peerDependencies['@deepseek-ai/cordis'], '~4.0.5')
})
