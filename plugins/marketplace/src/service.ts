/** Trusted single-source plugin Marketplace and profile mutation service. */

import { Service, type Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import type {} from '@deepseek-ai/dsh-host-webserver'
import { resolveProfileDir } from '@deepseek-ai/dsh-app-boot'
import { writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import { type SettingsScope } from '@deepseek-ai/dsh-settings'
import { createRequire } from 'node:module'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { z as wire } from 'zod'
import {
  readMarketplaceCatalogCache,
  writeMarketplaceCatalogCache,
  type MarketplaceCatalogCacheRequest,
} from './catalog-cache.ts'
import { runCommand } from './command.ts'
import { GongfengOAuthController, type GongfengOAuthConfig } from './oauth.ts'
import { OAuthCallbackListener, OAUTH_REDIRECT_URI } from './oauth-callback.ts'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { githubFile, githubRepository } from './github.ts'
import { parseRepositoryUrl } from './source.ts'
import { profilePnpmOptions } from './profile-pnpm.ts'
import { parseRepositoryFilePointer } from './repository-file.ts'
import type {
  InstalledMarketplacePlugin,
  MarketplaceCatalogView,
  MarketplaceConfigureRequest,
  MarketplaceMutationResult,
  MarketplaceOAuthRequest,
  MarketplaceOAuthStart,
  MarketplaceOAuthStatus,
  MarketplacePlugin,
  MarketplaceState,
} from './types.ts'

export type * from './types.ts'
export { parseMarketplaceCatalog } from './catalog.ts'

/** Stable Cordis service name. */
export const name = 'trusted-marketplace'

const DEFAULT_BASE_URL = 'https://gitlab.example.com/'
const DEFAULT_REPOSITORY = 'shamcleren/dsh-plugin'
const DEFAULT_REF = 'main'
const DEFAULT_CATALOG_PATH = 'marketplace.json'
const DEFAULT_OAUTH_CLIENT_ID = '78a69ee90433425fbd1cad0fe687c2e6'
const DEFAULT_OAUTH_ACCESS_TOKEN_REF = 'GONGFENG_OAUTH_ACCESS_TOKEN'
const DEFAULT_OAUTH_REFRESH_TOKEN_REF = 'GONGFENG_OAUTH_REFRESH_TOKEN'
const DEFAULT_MAX_ARTIFACT_BYTES = 50 * 1024 * 1024
const MAX_CATALOG_BYTES = 2 * 1024 * 1024

/** Marketplace source and installer policy. */
export interface Config {
  /** Gongfeng API base URL. */
  baseUrl?: string
  /** Single trusted namespace/repository source. */
  repository?: string
  /** Branch, tag, or commit used for the catalog and artifacts. */
  ref?: string
  /** Catalog path inside the repository. */
  catalogPath?: string
  /** Public Gongfeng OAuth application id used for PKCE. */
  oauthClientId?: string
  /** Credential reference containing the OAuth access token. */
  oauthAccessTokenRef?: string
  /** Credential reference containing the OAuth refresh token. */
  oauthRefreshTokenRef?: string
  /** Epoch milliseconds when the current OAuth access token expires. */
  oauthExpiresAt?: number
  /** Profile mutated by install, update, and removal operations. */
  profile?: string
  /** Maximum decoded tarball bytes. */
  maxArtifactBytes?: number
}

interface ResolvedConfig {
  baseUrl: string
  repository: string
  ref: string
  catalogPath: string
  oauthClientId: string
  oauthAccessTokenRef: string
  oauthRefreshTokenRef: string
  oauthExpiresAt?: number
  profile: string
  maxArtifactBytes: number
}

const packageManifestSchema = wire.looseObject({
  name: wire.string(),
  version: wire.string(),
  dsh: wire.looseObject({
    bundle: wire.looseObject({ patch: wire.string().min(1) }),
  }),
})

function packageVersion(): string {
  const manifest = JSON.parse(readFileSync(createRequire(import.meta.url).resolve('@deepseek-ai/dsh/package.json'), 'utf8')) as { version?: unknown }
  if (typeof manifest.version !== 'string') throw new Error('marketplace package manifest has no version')
  return manifest.version
}

function resolveConfig(config: Config): ResolvedConfig {
  const maxArtifactBytes = config.maxArtifactBytes ?? DEFAULT_MAX_ARTIFACT_BYTES
  if (!Number.isSafeInteger(maxArtifactBytes) || maxArtifactBytes <= 0) {
    throw new TypeError('marketplace: maxArtifactBytes must be a positive safe integer')
  }
  return {
    baseUrl: config.baseUrl ?? DEFAULT_BASE_URL,
    repository: config.repository ?? DEFAULT_REPOSITORY,
    ref: config.ref ?? DEFAULT_REF,
    catalogPath: config.catalogPath ?? DEFAULT_CATALOG_PATH,
    oauthClientId: config.oauthClientId ?? DEFAULT_OAUTH_CLIENT_ID,
    oauthAccessTokenRef: config.oauthAccessTokenRef ?? DEFAULT_OAUTH_ACCESS_TOKEN_REF,
    oauthRefreshTokenRef: config.oauthRefreshTokenRef ?? DEFAULT_OAUTH_REFRESH_TOKEN_REF,
    ...(config.oauthExpiresAt === undefined ? {} : { oauthExpiresAt: config.oauthExpiresAt }),
    profile: config.profile ?? 'web',
    maxArtifactBytes,
  }
}

function validateSource(baseUrl: string, repository: string, ref: string): void {
  parseRepositoryUrl(new URL(repository, baseUrl).href)
  if (ref.trim() === '' || /[\u0000-\u001f]/u.test(ref)) throw new Error('marketplace ref is invalid')
}

async function optionalFile(path: string): Promise<Buffer | undefined> {
  try {
    return await readFile(path)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
}

/** Remote Marketplace service backed by Gongfeng and the canonical profile CLI. */
export class MarketplaceService extends Service {
  static inject = ['credentials', 'webServer']
  static Config: z<Config> = z.object({
    baseUrl: z.string().default(DEFAULT_BASE_URL),
    repository: z.string().default(DEFAULT_REPOSITORY),
    ref: z.string().default(DEFAULT_REF),
    catalogPath: z.string().default(DEFAULT_CATALOG_PATH),
    oauthClientId: z.string().default(DEFAULT_OAUTH_CLIENT_ID),
    oauthAccessTokenRef: z.string().default(DEFAULT_OAUTH_ACCESS_TOKEN_REF),
    oauthRefreshTokenRef: z.string().default(DEFAULT_OAUTH_REFRESH_TOKEN_REF),
    oauthExpiresAt: z.number().step(1).min(0),
    profile: z.string().default('web'),
    maxArtifactBytes: z.number().step(1).min(1).default(DEFAULT_MAX_ARTIFACT_BYTES),
  })

  private readonly entry: Config
  private current: () => ResolvedConfig
  private settingsScope: SettingsScope<Config> | undefined
  private mutationTail: Promise<void> = Promise.resolve()
  private readonly oauth: GongfengOAuthController
  private readonly callbackListener: OAuthCallbackListener

  constructor(ctx: Context, config: Config = {}) {
    super(ctx, 'trustedMarketplace')
    this.entry = config
    this.current = () => resolveConfig(this.entry)
    this.oauth = new GongfengOAuthController(ctx.credentials, async (oauthExpiresAt) => {
      const scope = this.settingsScope
      if (scope === undefined) throw new Error('marketplace settings are unavailable')
      await scope.update({ oauthExpiresAt })
    })
    this.callbackListener = new OAuthCallbackListener((req, res) => this.handleOAuthCallback(req, res))
    ctx.effect(() => async () => { this.oauth.dispose(); await this.callbackListener.dispose() }, 'marketplace: OAuth lifetime')
    ctx.inject(['settings'], (settingsCtx) => {
      const scope = settingsCtx.settings.register(name, MarketplaceService.Config, {
        base: config,
      })
      this.settingsScope = scope
      this.current = () => resolveConfig(scope.get())
      settingsCtx.effect(() => () => {
        this.settingsScope = undefined
        this.current = () => resolveConfig(this.entry)
      })
    })
    ctx.effect(() => ctx.webServer.register({
      kind: 'exact',
      path: '/oauth/gongfeng/callback',
      handler: async (req, res) => { await this.handleOAuthCallback(req, res) },
    }), 'marketplace: Gongfeng OAuth callback')
  }

  private async handleOAuthCallback(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
    if (req.method !== 'GET') {
      res.writeHead(405, { 'content-type': 'text/plain; charset=utf-8' })
      res.end('method not allowed')
      return false
    }
    try {
      await this.oauth.callback(new URL(req.url ?? '/', OAUTH_REDIRECT_URI))
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' })
      res.end('<!doctype html><meta charset="utf-8"><title>DeepSeek Harness</title><p>授权已完成，可以关闭此页面并返回 DeepSeek Harness。</p>')
      return true
    } catch {
      res.writeHead(400, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' })
      res.end('<!doctype html><meta charset="utf-8"><title>DeepSeek Harness</title><p>授权失败。请关闭此页面并在 DeepSeek Harness 中重试。</p>')
      return false
    }
  }

  /**
   * Read safe source, credential, native bridge, and installed-package state.
   * @returns Browser-safe Marketplace state without credential values.
   */
  async state(): Promise<MarketplaceState> {
    const config = this.current()
    const oauthCredential = await this.ctx.credentials.describe(credentialRef(config.oauthAccessTokenRef))
    return {
      baseUrl: config.baseUrl,
      repository: config.repository,
      ref: config.ref,
      repositoryUrl: new URL(config.repository, config.baseUrl).href,
      host: parseRepositoryUrl(new URL(config.repository, config.baseUrl).href).host,
      oauthConfigured: oauthCredential.configured,
      nativeRestartAvailable: process.env.DSH_NATIVE_APP === '1',
      installed: await this.installed(config.profile),
    }
  }

  /**
   * Start a Gongfeng OAuth authorization using PKCE and the loopback callback.
   * @param request Repository address selected by the user.
   * @returns Authorization URL and polling identity.
   */
  async beginOAuth(request: MarketplaceOAuthRequest): Promise<MarketplaceOAuthStart> {
    const source = parseRepositoryUrl(request.repositoryUrl)
    if (source.host !== 'gongfeng') throw new Error('A public GitHub repository connects without OAuth')
    if (this.ctx.webServer.port !== Number(new URL(OAUTH_REDIRECT_URI).port)) await this.callbackListener.start()
    return this.oauth.begin(this.oauthConfig({ ...this.current(), baseUrl: source.baseUrl }))
  }

  /**
   * Poll one Gongfeng OAuth authorization.
   * @param flowId Identity returned from {@link beginOAuth}.
   * @returns Current flow status without authorization secrets.
   */
  oauthStatus(flowId: string): Promise<MarketplaceOAuthStatus> {
    return Promise.resolve(this.oauth.status(flowId))
  }

  /** Save one authorized repository, resolving its default branch without listing unrelated projects. */
  async configure(request: MarketplaceConfigureRequest): Promise<MarketplaceState> {
    const source = parseRepositoryUrl(request.repositoryUrl)
    const scope = this.settingsScope
    if (scope === undefined) throw new Error('marketplace settings are unavailable')
    if (source.host === 'github') {
      const project = await githubRepository(source.repository)
      await scope.update({ baseUrl: source.baseUrl, repository: source.repository, ref: project.defaultBranch })
      return await this.state()
    }
    const project = await this.oauth.repository(this.oauthConfig({ ...this.current(), baseUrl: source.baseUrl }), source.repository)
    if (!project.defaultBranch) throw new Error('The repository has no default branch')
    await scope.update({ baseUrl: source.baseUrl, repository: source.repository, ref: project.defaultBranch })
    return await this.state()
  }

  /**
   * Read the validated local Catalog cache, fetching it only on a cache miss.
   * @returns Compatible and incompatible entries from the current cached or remote Catalog.
   */
  async catalog(): Promise<MarketplaceCatalogView> {
    const config = this.current()
    validateSource(config.baseUrl, config.repository, config.ref)
    const cacheRequest = await this.catalogCacheRequest(config)
    return await readMarketplaceCatalogCache(cacheRequest)
      ?? await this.fetchCatalog(config, cacheRequest)
  }

  /**
   * Fetch the configured Catalog from its trusted source and atomically refresh the local cache.
   * @returns Compatible and incompatible entries from the refreshed Catalog.
   */
  async refreshCatalog(): Promise<MarketplaceCatalogView> {
    const config = this.current()
    validateSource(config.baseUrl, config.repository, config.ref)
    return await this.fetchCatalog(config, await this.catalogCacheRequest(config))
  }

  /**
   * Install or update one compatible Catalog package into the configured profile.
   * @param packageName Exact package identity present in the current Catalog.
   * @returns Mutation identity and restart requirement.
   */
  async add(packageName: string): Promise<MarketplaceMutationResult> {
    return await this.serializeMutation(async () => {
      const catalog = await this.catalog()
      const plugin = catalog.plugins.find(entry => entry.packageName === packageName)
      if (plugin === undefined) throw new Error(`marketplace package "${packageName}" is not in the catalog`)
      if (!plugin.compatible) throw new Error(`marketplace package "${packageName}" is incompatible with this DSH version`)
      const artifact = await this.cacheArtifact(this.current(), plugin)
      await this.mutateProfile(
        ['add', artifact, '--save-exact'],
        plugin.placement === 'before-web-app' ? async () => { await this.placeBeforeWebApp(packageName) } : undefined,
      )
      return { packageName, restartRequired: true }
    })
  }

  /**
   * Remove one installed Catalog package from the configured profile.
   * @param packageName Exact package identity present in the current Catalog.
   * @returns Mutation identity and restart requirement.
   */
  async deletePackage(packageName: string): Promise<MarketplaceMutationResult> {
    return await this.serializeMutation(async () => {
      const catalog = await this.catalog()
      if (!catalog.plugins.some(entry => entry.packageName === packageName)) {
        throw new Error(`marketplace package "${packageName}" is not in the catalog`)
      }
      await this.mutateProfile(['remove', packageName])
      return { packageName, restartRequired: true }
    })
  }

  private async repositoryFile(config: ResolvedConfig, path: string, maxBytes: number): Promise<Buffer> {
    const source = parseRepositoryUrl(new URL(config.repository, config.baseUrl).href)
    if (source.host === 'github') return githubFile(source.repository, path, config.ref, maxBytes)
    const pointer = parseRepositoryFilePointer(await this.oauth.repositoryFile({
      config: this.oauthConfig(config), repository: config.repository, path, ref: config.ref,
      maxBytes: Math.ceil(maxBytes * 1.5) + 1024 * 1024,
    }), maxBytes)
    const bytes = await this.oauth.repositoryRawFile({
      config: this.oauthConfig(config), repository: config.repository, commitId: pointer.commitId, path, maxBytes,
    })
    if (pointer.size !== undefined && pointer.size !== bytes.length) {
      throw new Error('marketplace raw blob size does not match repository metadata')
    }
    return bytes
  }

  private async catalogCacheRequest(config: ResolvedConfig): Promise<MarketplaceCatalogCacheRequest> {
    const installed = (await this.installed(config.profile)).sort((a, b) => a.packageName.localeCompare(b.packageName))
    return {
      home: resolveDshHome(),
      baseUrl: config.baseUrl,
      repository: config.repository,
      ref: config.ref,
      catalogPath: config.catalogPath,
      dshVersion: packageVersion(),
      profileState: JSON.stringify([resolveProfileDir(config.profile), installed]),
      maxArtifactBytes: config.maxArtifactBytes,
      maxCatalogBytes: MAX_CATALOG_BYTES,
    }
  }

  private async fetchCatalog(
    config: ResolvedConfig,
    cacheRequest: MarketplaceCatalogCacheRequest,
  ): Promise<MarketplaceCatalogView> {
    const bytes = await this.repositoryFile(config, config.catalogPath, MAX_CATALOG_BYTES)
    return await writeMarketplaceCatalogCache(cacheRequest, bytes.toString('utf8'))
  }

  private oauthConfig(config: ResolvedConfig): GongfengOAuthConfig {
    return {
      baseUrl: config.baseUrl,
      clientId: config.oauthClientId,
      redirectUri: OAUTH_REDIRECT_URI,
      accessTokenRef: config.oauthAccessTokenRef,
      refreshTokenRef: config.oauthRefreshTokenRef,
      ...(config.oauthExpiresAt === undefined ? {} : { expiresAt: config.oauthExpiresAt }),
    }
  }

  private async cacheArtifact(config: ResolvedConfig, plugin: MarketplacePlugin): Promise<string> {
    const cache = join(resolveDshHome(), 'plugin-cache')
    const destination = join(cache, `${plugin.artifact.sha256}.tgz`)
    const existing = await optionalFile(destination)
    if (existing !== undefined && this.matchesArtifact(existing, plugin)) return destination
    const bytes = await this.repositoryFile(config, plugin.artifact.path, config.maxArtifactBytes)
    if (!this.matchesArtifact(bytes, plugin)) throw new Error(`marketplace artifact verification failed for "${plugin.id}"`)
    await this.verifyPackageManifest(bytes, plugin, cache)
    await mkdir(cache, { recursive: true, mode: 0o700 })
    const pending = `${destination}.${String(process.pid)}.pending`
    await writeFile(pending, bytes, { mode: 0o600 })
    await rename(pending, destination)
    return destination
  }

  private matchesArtifact(bytes: Buffer, plugin: MarketplacePlugin): boolean {
    return bytes.length === plugin.artifact.size
      && createHash('sha256').update(bytes).digest('hex') === plugin.artifact.sha256
  }

  private async verifyPackageManifest(bytes: Buffer, plugin: MarketplacePlugin, cache: string): Promise<void> {
    await mkdir(cache, { recursive: true, mode: 0o700 })
    const temporary = join(cache, `.inspect-${String(process.pid)}-${plugin.id}.tgz`)
    await writeFile(temporary, bytes, { mode: 0o600 })
    try {
      const result = await runCommand('/usr/bin/tar', ['-xOf', temporary, 'package/package.json'], process.env, 1024 * 1024)
      const manifest = packageManifestSchema.parse(JSON.parse(result.stdout.toString('utf8')))
      if (manifest.name !== plugin.packageName || manifest.version !== plugin.version) {
        throw new Error(`marketplace artifact manifest does not match catalog entry "${plugin.id}"`)
      }
    } finally {
      await rm(temporary, { force: true })
    }
  }

  private async installed(profile: string): Promise<InstalledMarketplacePlugin[]> {
    const dir = resolveProfileDir(profile)
    const manifestPath = join(dir, 'package.json')
    let manifest: { dependencies?: Record<string, string> }
    try {
      manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as { dependencies?: Record<string, string> }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
      throw error
    }
    const result: InstalledMarketplacePlugin[] = []
    for (const [packageName, specifier] of Object.entries(manifest.dependencies ?? {})) {
      let version: string | undefined
      try {
        const installed = JSON.parse(await readFile(join(dir, 'node_modules', packageName, 'package.json'), 'utf8')) as { version?: unknown }
        if (typeof installed.version === 'string') version = installed.version
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      }
      result.push({ packageName, specifier, ...version === undefined ? {} : { version } })
    }
    return result
  }

  private async mutateProfile(pnpmArgs: readonly string[], after?: () => Promise<void>): Promise<void> {
    const config = this.current()
    const profileDir = resolveProfileDir(config.profile)
    const manifestPath = join(profileDir, 'package.json')
    const lockPath = join(profileDir, 'pnpm-lock.yaml')
    const beforeManifest = await optionalFile(manifestPath)
    const beforeLock = await optionalFile(lockPath)
    try {
      const entry = process.argv[1]
      if (entry === undefined) throw new Error('marketplace cannot locate the active dsh entry')
      await runCommand(process.execPath, [
        ...process.execArgv,
        entry,
        'plugin', '--profile', config.profile, '--config.ignore-scripts=true',
        ...await profilePnpmOptions(profileDir),
        ...pnpmArgs,
      ], process.env, 8 * 1024 * 1024)
      await after?.()
    } catch (error) {
      await this.restoreFile(manifestPath, beforeManifest)
      await this.restoreFile(lockPath, beforeLock)
      throw error
    }
  }

  private async placeBeforeWebApp(packageName: string): Promise<void> {
    const manifestPath = join(resolveProfileDir(this.current().profile), 'package.json')
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as {
      dsh?: { profile?: { bundles?: string[] } }
    }
    const bundles = manifest.dsh?.profile?.bundles
    if (bundles === undefined) throw new Error('marketplace profile manifest has no bundle list')
    const current = bundles.indexOf(packageName)
    const anchor = bundles.indexOf('@deepseek-ai/dsh-web-app')
    if (current < 0 || anchor < 0 || current < anchor) return
    bundles.splice(current, 1)
    bundles.splice(anchor, 0, packageName)
    await writeFileAtomic(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600, dirMode: 0o700 })
  }

  private async restoreFile(path: string, content: Buffer | undefined): Promise<void> {
    if (content === undefined) {
      await rm(path, { force: true })
      return
    }
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, content)
  }

  private async serializeMutation<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.mutationTail
    let release: () => void = () => undefined
    this.mutationTail = new Promise<void>((resolve) => { release = resolve })
    await previous
    try {
      return await operation()
    } finally {
      release()
    }
  }
}

export default MarketplaceService
