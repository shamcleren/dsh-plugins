import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import test from 'node:test'
import { captureLegacyIm, applyLegacyIm } from '../im-migration.mjs'

const repo = fileURLToPath(new URL('../../', import.meta.url)), runtime = join(repo, 'runtime')
const yaml = createRequire(join(runtime, 'package.json'))('yaml')
const wechat = '@shamcleren/dsh-wechat', wecom = '@shamcleren/dsh-wecom-aibot'
async function fixture(t) { const path = await mkdtemp(join(tmpdir(), 'dhp-im-migration-')); t.after(() => rm(path, { recursive: true, force: true })); return path }

test('IM replacement preserves config, retired flags and channel enable intent through official removal', async t => {
  const profile = await fixture(t), patch = join(profile, 'cordis.patch.yml')
  await writeFile(patch, `- id: wechat
  name: '@shamcleren/dsh-wechat'
  config:
    enabled: false
    accountIds: [fixture-old-filter]
    workspaceId: fixture-notes
- id: wecom-aibot
  disabled: true
  config:
    botIdEnv: FIXTURE_BOT
    secretEnv: FIXTURE_SECRET
    adminUsers: [fixture-owner]
`)
  const captured = await captureLegacyIm(profile, { dependencies: { [wechat]: 'previous', [wecom]: 'previous' }, dsh: { profile: { bundles: [wechat, wecom] } } }, runtime)
  // Simulate the official package remover retaining only unrelated overrides.
  await writeFile(patch, '- id: unrelated\n  config:\n    keep: true\n')
  await applyLegacyIm(profile, captured, runtime)
  const result = yaml.parse(await readFile(patch, 'utf8'))
  assert.deepEqual(result.find(row => row.id === 'unrelated'), { id: 'unrelated', config: { keep: true } })
  assert.deepEqual(result.find(row => row.id === 'wechat'), { id: 'wechat', config: { enabled: false, accountIds: ['fixture-old-filter'], workspaceId: 'fixture-notes', connectionEnabled: true } })
  assert.deepEqual(result.find(row => row.id === 'wecom-aibot'), { id: 'wecom-aibot', config: { botIdEnv: 'FIXTURE_BOT', secretEnv: 'FIXTURE_SECRET', adminUsers: ['fixture-owner'], connectionEnabled: false } })
  const once = await readFile(patch, 'utf8')
  await applyLegacyIm(profile, captured, runtime)
  assert.equal(await readFile(patch, 'utf8'), once)
})

test('IM replacement does not enable an undeclared or inactive channel', async t => {
  const profile = await fixture(t)
  const captured = await captureLegacyIm(profile, { dependencies: { [wechat]: 'previous' }, dsh: { profile: { bundles: [] } } }, runtime)
  assert.equal(captured.length, 1); assert.equal(captured[0].enabled, false)
  await applyLegacyIm(profile, captured, runtime)
  assert.deepEqual(yaml.parse(await readFile(join(profile, 'cordis.patch.yml'), 'utf8')), [{ id: 'wechat', config: { connectionEnabled: false } }])
  assert.deepEqual(await captureLegacyIm(profile, { dependencies: {} }, runtime), [])
})

test('ambiguous overrides and symlinks stop IM migration before profile mutation', async t => {
  const profile = await fixture(t), patch = join(profile, 'cordis.patch.yml')
  const manifest = { dependencies: { [wechat]: 'previous' } }
  const duplicate = '- id: wechat\n- id: wechat\n'
  await writeFile(patch, duplicate)
  await assert.rejects(captureLegacyIm(profile, manifest, runtime), /Ambiguous/)
  assert.equal(await readFile(patch, 'utf8'), duplicate)
  await rm(patch); await writeFile(join(profile, 'unknown.yml'), '[]\n'); await symlink('unknown.yml', patch)
  await assert.rejects(captureLegacyIm(profile, manifest, runtime), /regular profile patch/)
})
