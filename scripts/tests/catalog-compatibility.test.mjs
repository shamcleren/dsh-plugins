import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { releaseArtifact } from '../plugins.mjs'

const repo = fileURLToPath(new URL('../../', import.meta.url))
const json = async path => JSON.parse(await readFile(path, 'utf8'))

test('every plugin has an intact release with the pinned DSH contracts and public assets', async () => {
  const runtime = (await json(join(repo, 'runtime/package.json'))).dependencies['@deepseek-ai/dsh']
  const catalog = (await json(join(repo, 'marketplace.json'))).plugins
  const names = []
  for (const folder of await readdir(join(repo, 'plugins'), { withFileTypes: true })) {
    if (!folder.isDirectory()) continue
    const source = await json(join(repo, 'plugins', folder.name, 'package.json'))
    names.push(source.name)
    const entries = catalog.filter(entry => entry.package === source.name)
    assert.equal(entries.length, 1, source.name + ': one catalog entry')
    const entry = entries[0]
    assert.equal(entry.dshVersion, runtime, source.name + ': catalog runtime')
    assert.equal(entry.version, source.version, source.name + ': unpublished source version')
    await releaseArtifact(repo, entry)
    const tarball = join(repo, entry.artifact.path)
    const packed = JSON.parse(execFileSync('tar', ['-xOf', tarball, 'package/package.json'], { encoding: 'utf8' }))
    for (const key of ['exports', 'dependencies', 'peerDependencies', 'dsh', 'bin']) {
      assert.deepEqual(packed[key], source[key], source.name + ': release contract ' + key)
    }
    for (const [peer, version] of Object.entries(source.peerDependencies ?? {})) {
      if (peer.startsWith('@deepseek-ai/dsh')) assert.equal(version, runtime, source.name + ': ' + peer)
    }
    const files = new Set(execFileSync('tar', ['-tf', tarball], { encoding: 'utf8' }).trim().split('\n'))
    function checkExports(value) {
      if (typeof value === 'string') {
        assert.ok(files.has('package/' + value.replace(/^\.\//, '')), source.name + ': missing export ' + value)
      } else for (const child of Object.values(value ?? {})) checkExports(child)
    }
    checkExports(packed.exports)
    assert.ok(files.has('package/' + packed.dsh.bundle.patch.replace(/^\.\//, '')))
    for (const name of packed.dsh.client?.inject ?? []) {
      assert.ok(source.peerDependencies?.[name] || source.dependencies?.[name], source.name + ': undeclared browser dependency ' + name)
    }
  }
  assert.deepEqual(catalog.map(entry => entry.package).sort(), names.sort(), 'catalog covers all repository plugins')
})
