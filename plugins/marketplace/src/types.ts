/** Wire-safe Marketplace catalog and installation views. */

/** One immutable artifact published by the configured repository. */
export interface MarketplaceArtifact {
  readonly path: string
  readonly sha256: string
  readonly size: number
}

/** One installable package exposed by the trusted catalog. */
export interface MarketplacePlugin {
  readonly id: string
  readonly packageName: string
  readonly name: string
  readonly description: string
  readonly version: string
  readonly dshVersion: string
  readonly placement: 'before-web-app' | 'after-web-app'
  readonly artifact: MarketplaceArtifact
  readonly compatible: boolean
}

/** Catalog response plus the configured source identity. */
export interface MarketplaceCatalogView {
  readonly repository: string
  readonly ref: string
  readonly plugins: readonly MarketplacePlugin[]
}

/** Installed dependency that exports a DSH bundle. */
export interface InstalledMarketplacePlugin {
  readonly packageName: string
  readonly specifier: string
  readonly version?: string
}

/** Safe source and credential state for the Marketplace page. */
export interface MarketplaceState {
  readonly baseUrl: string
  readonly repository: string
  readonly ref: string
  readonly repositoryUrl: string
  readonly oauthConfigured: boolean
  readonly nativeRestartAvailable: boolean
  readonly installed: readonly InstalledMarketplacePlugin[]
}

/** Source update accepted from the trusted browser settings surface. */
export interface MarketplaceConfigureRequest {
  readonly repositoryUrl: string
}

/** Repository selected for an OAuth connection. */
export type MarketplaceOAuthRequest = MarketplaceConfigureRequest

/** Browser handoff data for one pending PKCE authorization. */
export interface MarketplaceOAuthStart {
  readonly flowId: string
  readonly authorizationUrl: string
}

/** Pollable status of one PKCE authorization flow. */
export type MarketplaceOAuthStatus =
  | { readonly status: 'pending' }
  | { readonly status: 'complete' }
  | { readonly status: 'failed'; readonly message: string }

/** One Gongfeng repository visible to the authorized user. */
export interface MarketplaceRepository {
  readonly id: number
  readonly path: string
  readonly name: string
  readonly defaultBranch?: string
}

/** Result of one profile mutation. */
export interface MarketplaceMutationResult {
  readonly packageName: string
  readonly restartRequired: boolean
}
