/** Shared validation, local/remote resolution, and verification for catalog release tarballs. */
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { lstat, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'

const capture = promisify(execFile)

export const MAX_ARTIFACT_BYTES = 50 * 1024 * 1024
const LOCAL_ARTIFACT_PATTERN = /^artifacts\/[^/\\]+\.tgz$/
const SHA256_PATTERN = /^[a-f0-9]{64}$/
const RELEASE_URL_PATTERN = /^https:\/\/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)\/releases\/download\/([^/?#]+)\/([^/?#\\]+\.tgz)$/
const ALLOWED_RELEASE_HOSTS = new Set([
  'github.com',
  'objects.githubusercontent.com',
  'release-assets.githubusercontent.com',
])

/** @param {Buffer | Uint8Array} bytes */
function sha256Hex(bytes) {
  return createHash('sha256').update(bytes).digest('hex')
}

/**
 * Parse and validate a GitHub Release download URL.
 * @param {string} value
 * @param {string} [expectedRepo]
 * @returns {{ url: URL, repository: string, tag: string, filename: string }}
 */
export function parseTrustedReleaseUrl(value, expectedRepo) {
  if (typeof value !== 'string') throw new Error('Invalid catalog artifact URL')
  const match = RELEASE_URL_PATTERN.exec(value)
  if (!match) throw new Error('Artifact URL must point to a GitHub Release .tgz asset')
  const url = new URL(value)
  if (url.protocol !== 'https:' || url.host !== 'github.com' || url.username || url.password || url.search || url.hash) {
    throw new Error('Artifact URL must be a plain HTTPS GitHub Release URL')
  }
  const [, owner, repo, tag, filename] = match
  for (const segment of [owner, repo, tag, filename]) {
    if (!segment || segment === '.' || segment === '..' || segment.includes('..') || /[\u0000-\u001f]/.test(segment)) {
      throw new Error('Artifact URL contains an invalid path segment')
    }
  }
  const repository = `${owner}/${repo}`
  if (expectedRepo !== undefined && repository.toLowerCase() !== expectedRepo.toLowerCase()) {
    throw new Error('Artifact URL repository does not match expected repository')
  }
  return { url, repository, tag, filename }
}

/**
 * Validate the shape of a catalog `artifact` descriptor.
 * @param {unknown} artifact
 * @returns {{ path?: string, url?: string, sha256: string, size: number }}
 */
export function validateArtifactDescriptor(artifact) {
  if (!artifact || typeof artifact !== 'object') throw new Error('Invalid catalog artifact')
  const record = /** @type {Record<string, unknown>} */ (artifact)
  const path = record.path
  const url = record.url
  const sha256 = record.sha256
  const size = record.size
  if (path === undefined && url === undefined) throw new Error('Catalog artifact must define path or url')
  let validPath
  if (path !== undefined) {
    if (typeof path !== 'string' || !LOCAL_ARTIFACT_PATTERN.test(path)) throw new Error('Invalid catalog artifact path')
    validPath = path
  }
  let validUrl
  if (url !== undefined) {
    if (typeof url !== 'string') throw new Error('Invalid catalog artifact URL')
    parseTrustedReleaseUrl(url)
    validUrl = url
  }
  if (typeof sha256 !== 'string' || !SHA256_PATTERN.test(sha256)) {
    throw new Error('Invalid catalog artifact sha256')
  }
  if (typeof size !== 'number' || !Number.isSafeInteger(size) || size <= 0 || size > MAX_ARTIFACT_BYTES) {
    throw new Error('Invalid catalog artifact size')
  }
  return {
    ...(validPath === undefined ? {} : { path: validPath }),
    ...(validUrl === undefined ? {} : { url: validUrl }),
    sha256,
    size,
  }
}

/**
 * Read a bounded response body, rejecting payloads exceeding `maxBytes`.
 * @param {Response} response
 * @param {number} maxBytes
 * @returns {Promise<Buffer>}
 */
async function readBoundedBytes(response, maxBytes) {
  const declared = response.headers.get('content-length')
  if (declared !== null) {
    const length = Number(declared)
    if (!Number.isFinite(length) || length < 0 || length > maxBytes) {
      await response.body?.cancel()
      throw new Error('Remote artifact response exceeded declared size limit')
    }
  }
  if (!response.body) return Buffer.alloc(0)
  const reader = response.body.getReader()
  /** @type {Buffer[]} */
  const chunks = []
  let total = 0
  while (true) {
    const chunk = await reader.read()
    if (chunk.done) break
    total += chunk.value.byteLength
    if (total > maxBytes) {
      await reader.cancel()
      throw new Error('Remote artifact response exceeded size limit')
    }
    chunks.push(Buffer.from(chunk.value))
  }
  return Buffer.concat(chunks, total)
}

/**
 * Download a GitHub Release artifact following only allowlisted HTTPS hosts.
 * @param {string} rawUrl
 * @param {number} expectedSize
 * @param {{ fetchImpl?: typeof fetch, maxRedirects?: number, timeoutMs?: number }} [options]
 * @returns {Promise<Buffer>}
 */
export async function downloadReleaseArtifact(rawUrl, expectedSize, options = {}) {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch
  const maxRedirects = options.maxRedirects ?? 3
  const timeoutMs = options.timeoutMs ?? 60_000
  if (typeof fetchImpl !== 'function') throw new Error('Fetch API is unavailable for downloading remote artifacts')
  let current = parseTrustedReleaseUrl(rawUrl).url
  for (let redirects = 0; redirects <= maxRedirects; redirects++) {
    if (current.protocol !== 'https:' || !ALLOWED_RELEASE_HOSTS.has(current.host)) {
      throw new Error('Refused to fetch artifact from untrusted host: ' + current.host)
    }
    const response = await fetchImpl(current, {
      method: 'GET',
      redirect: 'manual',
      headers: {
        accept: 'application/octet-stream',
        'user-agent': 'dsh-plugins-installer',
      },
      signal: AbortSignal.timeout(timeoutMs),
    })
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location')
      await response.body?.cancel()
      if (!location || redirects === maxRedirects) {
        throw new Error('Refused remote artifact redirect')
      }
      current = new URL(location, current)
      continue
    }
    if (!response.ok) {
      await response.body?.cancel()
      throw new Error(`Failed to download remote artifact (HTTP ${response.status})`)
    }
    return readBoundedBytes(response, expectedSize)
  }
  throw new Error('Exceeded remote artifact redirect limit')
}

/**
 * Inspect `package/package.json` inside a verified tarball and validate catalog provenance.
 * @param {string} tarballPath
 * @param {{ package: string, version: string, sourceDigest?: string }} entry
 */
async function verifyTarballManifest(tarballPath, entry) {
  const { stdout } = await capture('tar', ['-xOf', tarballPath, 'package/package.json'], { maxBuffer: 1024 * 1024 })
  const manifest = JSON.parse(stdout)
  if (manifest.name !== entry.package || manifest.version !== entry.version || typeof manifest.dsh?.bundle?.patch !== 'string') {
    throw new Error('Artifact package identity/version/bundle does not match the catalog')
  }
  if (entry.sourceDigest !== undefined && (!SHA256_PATTERN.test(entry.sourceDigest) ||
      manifest.dshPluginRelease?.schemaVersion !== 1 || manifest.dshPluginRelease.sourceDigest !== entry.sourceDigest)) {
    throw new Error('Artifact build provenance does not match the catalog')
  }
}

/**
 * Read a local regular file (rejecting symlinks). Returns undefined on ENOENT.
 * @param {string} filePath
 * @param {number} expectedSize
 * @returns {Promise<Buffer | undefined>}
 */
async function readVerifiedLocalFile(filePath, expectedSize) {
  let stat
  try { stat = await lstat(filePath) } catch (error) {
    if (/** @type {NodeJS.ErrnoException} */ (error).code === 'ENOENT') return undefined
    throw error
  }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size !== expectedSize) {
    throw new Error('Artifact size or file type mismatch')
  }
  return readFile(filePath)
}

/**
 * Resolve and verify a catalog artifact from cache, local repository path, or GitHub Release URL.
 * @param {string} repo
 * @param {{ package: string, version: string, sourceDigest?: string, artifact: unknown }} entry
 * @param {{ cacheDir?: string, fetchImpl?: typeof fetch }} [options]
 * @returns {Promise<Buffer>}
 */
export async function resolveReleaseArtifact(repo, entry, options = {}) {
  const artifact = validateArtifactDescriptor(entry.artifact)

  if (options.cacheDir) {
    const cachedPath = join(options.cacheDir, `${artifact.sha256}.tgz`)
    const cached = await readVerifiedLocalFile(cachedPath, artifact.size)
    if (cached !== undefined) {
      if (sha256Hex(cached) !== artifact.sha256) throw new Error('Cached artifact SHA-256 mismatch')
      await verifyTarballManifest(cachedPath, entry)
      return cached
    }
  }

  if (artifact.path !== undefined) {
    const localPath = join(repo, artifact.path)
    const localBytes = await readVerifiedLocalFile(localPath, artifact.size)
    if (localBytes !== undefined) {
      if (sha256Hex(localBytes) !== artifact.sha256) throw new Error('Artifact SHA-256 mismatch')
      await verifyTarballManifest(localPath, entry)
      return localBytes
    }
    if (artifact.url === undefined) {
      const error = /** @type {NodeJS.ErrnoException} */ (new Error('Missing local artifact: ' + localPath))
      error.code = 'ENOENT'
      throw error
    }
  }

  if (artifact.url === undefined) throw new Error('Catalog artifact has no local path or remote URL')
  const bytes = await downloadReleaseArtifact(artifact.url, artifact.size, {
    ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
  })
  if (bytes.length !== artifact.size) throw new Error('Artifact size mismatch')
  if (sha256Hex(bytes) !== artifact.sha256) throw new Error('Artifact SHA-256 mismatch')

  const scratch = await mkdtemp(join(tmpdir(), 'dhp-artifact-'))
  try {
    const temporary = join(scratch, 'artifact.tgz')
    await writeFile(temporary, bytes, { mode: 0o600 })
    await verifyTarballManifest(temporary, entry)
  } finally {
    await rm(scratch, { recursive: true, force: true })
  }
  return bytes
}
