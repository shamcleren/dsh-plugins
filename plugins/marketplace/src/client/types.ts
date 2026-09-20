/** Browser-safe Marketplace values used by the external client bundle. */

export interface MarketplaceArtifact {
  readonly path: string
  readonly sha256: string
  readonly size: number
}

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

export interface InstalledPlugin {
  readonly packageName: string
  readonly specifier: string
  readonly version?: string
}

export interface MarketplaceState {
  readonly baseUrl: string
  readonly repository: string
  readonly ref: string
  readonly repositoryUrl: string
  readonly oauthConfigured: boolean
  readonly nativeRestartAvailable: boolean
  readonly installed: readonly InstalledPlugin[]
}

export interface CatalogView {
  readonly repository: string
  readonly ref: string
  readonly plugins: readonly MarketplacePlugin[]
}

export interface MutationResult {
  readonly packageName: string
  readonly restartRequired: boolean
}

export interface OAuthStart { readonly flowId: string; readonly authorizationUrl: string }
export type OAuthStatus = { readonly status: 'pending' } | { readonly status: 'complete' } | { readonly status: 'failed'; readonly message: string }
export interface Repository { readonly id: number; readonly path: string; readonly name: string; readonly defaultBranch?: string }

export interface MarketplaceRemote {
  state(): Promise<MarketplaceState>
  catalog(): Promise<CatalogView>
  refreshCatalog(): Promise<CatalogView>
  configure(request: { repositoryUrl: string }): Promise<MarketplaceState>
  add(packageName: string): Promise<MutationResult>
  deletePackage(packageName: string): Promise<MutationResult>
  beginOAuth(request: { repositoryUrl: string }): Promise<OAuthStart>
  oauthStatus(flowId: string): Promise<OAuthStatus>
}
