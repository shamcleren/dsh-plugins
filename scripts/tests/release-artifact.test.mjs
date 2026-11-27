import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import {
  downloadReleaseArtifact,
  parseTrustedReleaseUrl,
  resolveReleaseArtifact,
  validateArtifactDescriptor,
} from '../release-artifact.mjs'
import { parsePublishArgs, publishGithubRelease } from '../publish-github-release.mjs'

const repository = fileURLToPath(new URL('../../', import.meta.url))
const catalog = JSON.parse(await readFile(join(repository, 'marketplace.json'), 'utf8'))
const sampleEntry = catalog.plugins.find(entry => entry.id === 'web-search')

test('validateArtifactDescriptor accepts path-only, url-only, and dual descriptors while rejecting invalid inputs', () => {
  const sha = 'a'.repeat(64)
  assert.equal(validateArtifactDescriptor({ path: 'artifacts/a.tgz', sha256: sha, size: 12 }).path, 'artifacts/a.tgz')
  const url = 'https://github.com/shamcleren/dsh-plugins/releases/download/v1.0.0/a.tgz'
  assert.equal(validateArtifactDescriptor({ url, sha256: sha, size: 12 }).url, url)
  assert.throws(() => validateArtifactDescriptor({ sha256: sha, size: 12 }), /path or url/)
  assert.throws(() => validateArtifactDescriptor({ url: 'http://github.com/a/b/releases/download/v1/a.tgz', sha256: sha, size: 12 }), /GitHub Release/)
  assert.throws(() => validateArtifactDescriptor({ url: 'https://evil.example/a/b/releases/download/v1/a.tgz', sha256: sha, size: 12 }), /GitHub Release/)
  assert.throws(() => parseTrustedReleaseUrl(url, 'other/repo'), /does not match/)
})

test('resolveReleaseArtifact downloads verified GitHub Release tarball and reuses cache', async t => {
  const scratch = await mkdtemp(join(tmpdir(), 'dhp-release-artifact-'))
  t.after(() => rm(scratch, { recursive: true, force: true }))
  const bytes = await readFile(join(repository, sampleEntry.artifact.path))
  const remoteUrl = `https://github.com/shamcleren/dsh-plugins/releases/download/plugins-test/${sampleEntry.artifact.path.split('/').at(-1)}`
  const remoteEntry = {
    ...sampleEntry,
    artifact: { url: remoteUrl, sha256: sampleEntry.artifact.sha256, size: sampleEntry.artifact.size },
  }

  let calls = 0
  const fetchImpl = async input => {
    calls++
    const current = String(input)
    if (current.startsWith('https://github.com/')) {
      return new Response(null, { status: 302, headers: { location: 'https://objects.githubusercontent.com/github-production-release-asset/sample.tgz' } })
    }
    return new Response(bytes, { status: 200, headers: { 'content-length': String(bytes.length) } })
  }

  const resolved = await resolveReleaseArtifact(scratch, remoteEntry, { fetchImpl })
  assert.equal(resolved.length, bytes.length)
  assert.equal(createHash('sha256').update(resolved).digest('hex'), sampleEntry.artifact.sha256)
  assert.equal(calls, 2)

  // Cached artifact satisfies subsequent resolution without hitting network.
  const cacheDir = join(scratch, 'cache')
  await mkdir(cacheDir, { recursive: true })
  await writeFile(join(cacheDir, `${sampleEntry.artifact.sha256}.tgz`), bytes)
  const cached = await resolveReleaseArtifact(scratch, remoteEntry, {
    cacheDir,
    fetchImpl: async () => { throw new Error('network should not be called') },
  })
  assert.equal(cached.equals(bytes), true)
})

test('downloadReleaseArtifact rejects untrusted redirect hosts, HTTP errors, and oversized bodies', async () => {
  const url = 'https://github.com/shamcleren/dsh-plugins/releases/download/v1.0.0/pkg.tgz'
  await assert.rejects(
    downloadReleaseArtifact(url, 64, {
      fetchImpl: async () => new Response(null, { status: 302, headers: { location: 'https://evil.example/pkg.tgz' } }),
    }),
    /untrusted host/,
  )
  await assert.rejects(
    downloadReleaseArtifact(url, 4, {
      fetchImpl: async () => new Response(Buffer.from('oversized-payload'), { status: 200 }),
    }),
    /size limit/,
  )
  await assert.rejects(
    downloadReleaseArtifact(url, 64, {
      fetchImpl: async () => new Response('missing', { status: 404 }),
    }),
    /HTTP 404/,
  )
})

test('publishGithubRelease plans verified upload and transitions catalog to URL-only distribution', async t => {
  const scratch = await mkdtemp(join(tmpdir(), 'dhp-publish-release-'))
  t.after(() => rm(scratch, { recursive: true, force: true }))
  await mkdir(join(scratch, 'artifacts'), { recursive: true })
  await cp(join(repository, sampleEntry.artifact.path), join(scratch, sampleEntry.artifact.path))
  await writeFile(join(scratch, 'marketplace.json'), JSON.stringify({ schemaVersion: 1, plugins: [sampleEntry] }, null, 2) + '\n')

  assert.throws(() => parsePublishArgs([]), /--tag/)
  assert.throws(() => parsePublishArgs(['--tag', 'v1', '--remove-local']), /--update-catalog/)

  const logs = []
  const dry = await publishGithubRelease({ repo: scratch, tag: 'plugins-2026-11', log: line => logs.push(line) })
  assert.equal(dry.assets.length, 1)
  assert.match(dry.assets[0].url, /^https:\/\/github\.com\/shamcleren\/dsh-plugins\/releases\/download\/plugins-2026-11\//)
  assert.ok(logs.some(line => line.includes('Dry run')))

  const executed = []
  await publishGithubRelease({
    repo: scratch,
    tag: 'plugins-2026-11',
    execute: true,
    updateCatalog: true,
    removeLocal: true,
    runner: async (cmd, args) => { executed.push([cmd, args]) },
    log: () => {},
  })
  assert.equal(executed.length, 1)
  assert.equal(executed[0][0], 'gh')
  const updated = JSON.parse(await readFile(join(scratch, 'marketplace.json'), 'utf8'))
  assert.equal(updated.plugins[0].artifact.path, undefined)
  assert.equal(updated.plugins[0].artifact.url, dry.assets[0].url)
  await assert.rejects(readFile(join(scratch, sampleEntry.artifact.path)), { code: 'ENOENT' })
})
