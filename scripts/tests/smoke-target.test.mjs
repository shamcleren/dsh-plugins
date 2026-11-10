import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import test from 'node:test'
import { smokeTarget } from '../smoke-target.mjs'

async function fixture(t) {
  const repo = await mkdtemp(join(tmpdir(), 'dsh-smoke-target-'))
  t.after(() => rm(repo, { recursive: true, force: true }))
  const desktopApp = join(repo, 'DSH with spaces.app'), resources = join(desktopApp, 'Contents/Resources')
  await mkdir(join(desktopApp, 'Contents/MacOS'), { recursive: true })
  return { repo, desktopApp, resources }
}

test('native App smoke uses the bundled Node/runtime and Web profile rather than the developer runtime', async t => {
  const f = await fixture(t)
  await writeFile(join(f.desktopApp, 'Contents/MacOS/DeepSeekHarness'), '', { mode: 0o700 })
  await mkdir(join(f.resources, 'node/bin'), { recursive: true })
  await writeFile(join(f.resources, 'node/bin/node'), '', { mode: 0o700 })
  const runtime = join(f.resources, 'runtime')
  await mkdir(join(runtime, 'node_modules/@deepseek-ai/dsh'), { recursive: true })
  await writeFile(join(runtime, 'node_modules/@deepseek-ai/dsh/package.json'), JSON.stringify({ name: '@deepseek-ai/dsh', version: '0.2.1-rc.5' }))
  assert.deepEqual(await smokeTarget(f), { kind: 'native', node: join(f.resources, 'node/bin/node'), runtime, profileName: 'web', version: '0.2.1-rc.5' })
  await assert.rejects(smokeTarget({ ...f, runtimeOverride: join(f.repo, 'runtime') }), /must use its bundled runtime/)
})

test('an incomplete native bundle fails before installing any plugin', async t => {
  const f = await fixture(t)
  await writeFile(join(f.desktopApp, 'Contents/MacOS/DeepSeekHarness'), '', { mode: 0o700 })
  await assert.rejects(smokeTarget(f), /no executable bundled Node/)
})

test('the official Electron Desktop still selects its distinct profile and executable', async t => {
  const f = await fixture(t), electron = join(f.desktopApp, 'Contents/MacOS/DeepSeek Harness')
  await writeFile(electron, '', { mode: 0o700 })
  assert.deepEqual(await smokeTarget({ ...f, node: '/fixture/node' }), {
    kind: 'electron', runtime: join(f.repo, 'runtime'), node: '/fixture/node', profileName: 'desktop', electron,
  })
})

test('an unknown App layout fails explicitly instead of falling back to a developer runtime', async t => {
  const f = await fixture(t)
  await assert.rejects(smokeTarget(f), /Unsupported Desktop App layout/)
  assert.deepEqual(await smokeTarget({ repo: f.repo, node: '/fixture/node' }), {
    kind: 'web', runtime: join(f.repo, 'runtime'), node: '/fixture/node', profileName: 'web',
  })
})
