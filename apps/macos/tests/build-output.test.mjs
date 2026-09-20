import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { buildAppOutput } from '../build-output.mjs'

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-build-output-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  return join(root, 'apps')
}

test('publishes DeepSeek Harness.app and cleans its private staging directory and lock', async t => {
  const directory = await fixture(t)
  const output = await buildAppOutput(directory, async app => {
    await mkdir(app)
    await writeFile(join(app, 'built'), 'verified application')
  })
  assert.equal(output, join(directory, 'DeepSeek Harness.app'))
  assert.equal(await readFile(join(output, 'built'), 'utf8'), 'verified application')
  assert.deepEqual(await readdir(directory), ['DeepSeek Harness.app'])
})

for (const kind of ['directory', 'file', 'symlink']) test(`existing ${kind} outputs are never overwritten`, async t => {
  const directory = await fixture(t)
  await mkdir(directory)
  const output = join(directory, 'DeepSeek Harness.app')
  if (kind === 'directory') await mkdir(output)
  else if (kind === 'file') await writeFile(output, 'keep')
  else await symlink('/missing-app-target', output)
  await assert.rejects(buildAppOutput(directory, () => assert.fail('must not start building')), /already exists/)
  assert.deepEqual(await readdir(directory), ['DeepSeek Harness.app'])
})

test('concurrent builders cannot publish into the same directory', async t => {
  const directory = await fixture(t)
  let entered, release
  const started = new Promise(resolve => { entered = resolve })
  const gate = new Promise(resolve => { release = resolve })
  const first = buildAppOutput(directory, async app => { await mkdir(app); entered(); await gate })
  await started
  try { await assert.rejects(buildAppOutput(directory, () => assert.fail('concurrent build')), /holds .app-build.lock/) }
  finally { release(); await first }
})

test('failed builds clean up and allow a later retry', async t => {
  const directory = await fixture(t)
  await assert.rejects(buildAppOutput(directory, async app => { await mkdir(app); throw new Error('compile failed') }), /compile failed/)
  assert.deepEqual(await readdir(directory), [])
  await buildAppOutput(directory, app => mkdir(app))
  assert.deepEqual(await readdir(directory), ['DeepSeek Harness.app'])
})

test('an app appearing during compilation is left intact', async t => {
  const directory = await fixture(t)
  await assert.rejects(buildAppOutput(directory, async (app, output) => {
    await mkdir(app)
    await mkdir(output)
    await writeFile(join(output, 'keep'), 'user app')
  }), /already exists/)
  assert.equal(await readFile(join(directory, 'DeepSeek Harness.app/keep'), 'utf8'), 'user app')
})
