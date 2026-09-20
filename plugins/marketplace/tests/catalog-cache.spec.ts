import { mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  readMarketplaceCatalogCache,
  writeMarketplaceCatalogCache,
  type MarketplaceCatalogCacheRequest,
} from '../src/catalog-cache.ts'

function catalog(version = '1.0.0'): string {
  return JSON.stringify({
    schemaVersion: 1,
    plugins: [{
      id: 'example', package: '@example/plugin', name: 'Example', description: 'Example plugin',
      version, dshVersion: '>=0.1.0-rc.8',
      artifact: { path: 'artifacts/example.tgz', sha256: 'a'.repeat(64), size: 42 },
    }],
  })
}

async function request(): Promise<MarketplaceCatalogCacheRequest> {
  return {
    home: await mkdtemp(join(tmpdir(), 'dsh-marketplace-cache-')),
    baseUrl: 'https://git.example/', repository: 'owner/repository', ref: 'main',
    catalogPath: 'marketplace.json', dshVersion: '0.1.0-rc.8', maxArtifactBytes: 1024, maxCatalogBytes: 4096,
  }
}

describe('Marketplace Catalog cache', () => {
  it('round-trips a validated Catalog without a remote request', async () => {
    const target = await request()
    await writeMarketplaceCatalogCache(target, catalog('1.2.3'))
    await expect(readMarketplaceCatalogCache(target)).resolves.toMatchObject({
      repository: 'owner/repository', plugins: [{ version: '1.2.3' }],
    })
  })

  it('treats corrupted cached content as a cache miss', async () => {
    const target = await request()
    await writeMarketplaceCatalogCache(target, catalog())
    const cacheDir = join(target.home, 'plugin-cache')
    const [file] = await readdir(cacheDir)
    if (file === undefined) throw new Error('cache file was not created')
    await writeFile(join(cacheDir, file), '{broken')
    await expect(readMarketplaceCatalogCache(target)).resolves.toBeUndefined()
    expect(await readFile(join(cacheDir, file), 'utf8')).toBe('{broken')
  })
})
