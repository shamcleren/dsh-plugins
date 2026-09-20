/** Validation for untrusted Marketplace repository data. */

import { satisfies, valid as validVersion, validRange } from 'semver'
import { z } from 'zod'
import type { MarketplaceCatalogView, MarketplacePlugin } from './types.ts'

const ID = /^[a-z][a-z0-9-]*$/
const PACKAGE = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/
const SHA256 = /^[a-f0-9]{64}$/

const artifactSchema = z.object({
  path: z.string().min(1),
  sha256: z.string().regex(SHA256),
  size: z.number().int().positive(),
}).strict()

const pluginSchema = z.object({
  id: z.string().regex(ID),
  package: z.string().regex(PACKAGE),
  name: z.string().min(1),
  description: z.string().min(1),
  version: z.string().min(1),
  dshVersion: z.string().min(1),
  placement: z.enum(['before-web-app', 'after-web-app']).optional(),
  artifact: artifactSchema,
}).strict()

const catalogSchema = z.object({
  schemaVersion: z.literal(1),
  plugins: z.array(pluginSchema),
}).strict()

function safeRepositoryPath(value: string): boolean {
  return !value.startsWith('/')
    && !value.includes('\\')
    && value.split('/').every(segment => segment !== '' && segment !== '.' && segment !== '..')
}

/** Inputs needed to validate and project one Catalog. */
export interface MarketplaceCatalogParseRequest {
  readonly text: string
  readonly repository: string
  readonly ref: string
  readonly dshVersion: string
  readonly maxArtifactBytes: number
}

/**
 * Parse and detach one Catalog while deriving Host-version compatibility.
 * @param request Untrusted text plus trusted source and Host limits.
 * @returns An immutable validated Catalog view.
 */
export function parseMarketplaceCatalog(request: MarketplaceCatalogParseRequest): MarketplaceCatalogView {
  const raw: unknown = JSON.parse(request.text)
  const parsed = catalogSchema.parse(raw)
  const ids = new Set<string>()
  const packages = new Set<string>()
  const plugins: MarketplacePlugin[] = parsed.plugins.map((entry) => {
    if (ids.has(entry.id)) throw new Error(`marketplace catalog has duplicate id "${entry.id}"`)
    if (packages.has(entry.package)) throw new Error(`marketplace catalog has duplicate package "${entry.package}"`)
    if (!safeRepositoryPath(entry.artifact.path)) {
      throw new Error(`marketplace artifact path is unsafe for "${entry.id}"`)
    }
    if (entry.artifact.size > request.maxArtifactBytes) {
      throw new Error(`marketplace artifact for "${entry.id}" exceeds the configured size limit`)
    }
    if (validVersion(entry.version) === null) {
      throw new Error(`marketplace plugin "${entry.id}" has an invalid version`)
    }
    if (validRange(entry.dshVersion) === null) {
      throw new Error(`marketplace plugin "${entry.id}" has an invalid dshVersion range`)
    }
    ids.add(entry.id)
    packages.add(entry.package)
    return Object.freeze({
      id: entry.id,
      packageName: entry.package,
      name: entry.name,
      description: entry.description,
      version: entry.version,
      dshVersion: entry.dshVersion,
      placement: entry.placement ?? 'after-web-app',
      artifact: Object.freeze({ ...entry.artifact }),
      compatible: satisfies(request.dshVersion, entry.dshVersion, { includePrerelease: true }),
    })
  })
  return Object.freeze({ repository: request.repository, ref: request.ref, plugins: Object.freeze(plugins) })
}
