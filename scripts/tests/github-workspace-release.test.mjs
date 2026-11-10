import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'
import test from 'node:test'
import { releaseArtifact } from '../plugins.mjs'

test('the catalog client factory mounts a localized GitHub workspace page using the public bundle slot', async () => {
  const repo = fileURLToPath(new URL('../../', import.meta.url))
  const entry = JSON.parse(await readFile(join(repo, 'marketplace.json'), 'utf8')).plugins.find(entry => entry.id === 'github-workspace')
  await releaseArtifact(repo, entry)
  const client = execFileSync('tar', ['-xOf', join(repo, entry.artifact.path), 'package/lib/client.js'], { encoding: 'utf8' })
  const require = createRequire(join(repo, 'plugins/github-workspace/package.json'))
  let plugin, render, registered
  runInNewContext(client, { window: { __ModuleLoader__: { load(module) {
    assert.equal(module.id, entry.package)
    plugin = module.factory(require)
  } } } })
  assert.equal(typeof plugin.apply, 'function')
  plugin.apply({
    effect() {}, get() { return { rpc: { call() { throw new Error('SSR must not perform requests') } } } },
    locale: { register() {}, bind() { return key => key } },
    slots: { inject(name, apply) { assert.equal(name, 'plugins.bundle.config'); apply() }, register(metadata, factory) { registered = metadata; render = factory } },
  })
  assert.equal(registered.key, entry.package)
  const html = require('react-dom/server').renderToString(render())
  assert.match(html, /<h2>dashboardTitle<\/h2>/)
  assert.match(html, /signInButton/)
  assert.match(html, /<select id="ghw-owner"/)
  assert.match(html, /<select id="ghw-repository"/)
  assert.match(html, /type="search"/)
  assert.doesNotMatch(html, /undefined|\[object Object\]/)
})
