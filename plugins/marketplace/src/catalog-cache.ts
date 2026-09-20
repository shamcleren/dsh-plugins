/** Persistent Marketplace Catalog cache keyed by the configured repository source. */

import { createHash } from 'node:crypto'
import { readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import type { MarketplaceCatalogView } from './types.ts'
import { parseMarketplaceCatalog } from './catalog.ts'

/** Source identity, validation limits, and storage root for one Catalog cache entry. */
export interface MarketplaceCatalogCacheRequest {
  /** Absolute Harness home containing `plugin-cache`. */
  readonly home: string
  /** Trusted Gongfeng API origin. */
  readonly baseUrl: string
  /** Trusted namespace/repository identity. */
  readonly repository: string
  /** Branch, tag, or commit selecting repository content. */
  readonly ref: string
  /** Repository-relative Catalog path. */
  readonly catalogPath: string
  /** Running DSH version used to derive entry compatibility. */
  readonly dshVersion: string
  /** Maximum artifact size accepted while parsing the Catalog. */
  readonly maxArtifactBytes: number
  /** Maximum bytes read from or written to one cache entry. */
  readonly maxCatalogBytes: number
}

function cacheFile(request: MarketplaceCatalogCacheRequest): string {
  const source = [request.baseUrl, request.repository, request.ref, request.catalogPath].join('\0')
  const key = createHash('sha256').update(source).digest('hex')
  return join(request.home, 'plugin-cache', `catalog-${key}.json`)
}

function parseCachedCatalog(text: string, request: MarketplaceCatalogCacheRequest): MarketplaceCatalogView {
  return parseMarketplaceCatalog({
    text,
    repository: request.repository,
    ref: request.ref,
    dshVersion: request.dshVersion,
    maxArtifactBytes: request.maxArtifactBytes,
  })
}

/**
 * Read a valid source-specific Catalog cache; malformed or absent cache files are misses.
 * @param request - Source identity, validation limits, and Harness storage root.
 * @returns The validated cached Catalog, or `undefined` when the cache cannot be reused.
 */
export async function readMarketplaceCatalogCache(
  request: MarketplaceCatalogCacheRequest,
): Promise<MarketplaceCatalogView | undefined> {
  let text: string
  try {
    const path = cacheFile(request)
    if ((await stat(path)).size > request.maxCatalogBytes) return undefined
    text = await readFile(path, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
  try {
    return parseCachedCatalog(text, request)
  } catch {
    // A cache is disposable; the caller replaces malformed or obsolete content from the trusted source.
    return undefined
  }
}

/**
 * Atomically replace the source-specific Catalog cache after validating its contents.
 * @param request - Source identity, validation limits, and Harness storage root.
 * @param text - Exact trusted repository Catalog text.
 * @returns The validated Catalog written to the cache.
 */
export async function writeMarketplaceCatalogCache(
  request: MarketplaceCatalogCacheRequest,
  text: string,
): Promise<MarketplaceCatalogView> {
  if (Buffer.byteLength(text) > request.maxCatalogBytes) throw new Error('marketplace Catalog exceeds the configured cache limit')
  const catalog = parseCachedCatalog(text, request)
  await writeFileAtomic(cacheFile(request), text, { mode: 0o600, dirMode: 0o700 })
  return catalog
}
