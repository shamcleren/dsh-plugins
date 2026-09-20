/** Gongfeng OAuth 2.0 PKCE flow and authorized API access. */

import type { CredentialProvider } from '@deepseek-ai/dsh-credentials'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { z } from 'zod'
import { GONGFENG_ORIGIN } from './source.ts'
import type {
  MarketplaceOAuthStart,
  MarketplaceOAuthStatus,
  MarketplaceRepository,
} from './types.ts'

const FLOW_LIFETIME_MS = 10 * 60 * 1000
const TOKEN_RESPONSE_BYTES = 64 * 1024
const API_RESPONSE_BYTES = 4 * 1024 * 1024

const tokenSchema = z.looseObject({
  access_token: z.string().min(1),
  refresh_token: z.string().min(1),
  expires_in: z.number().int().positive(),
})

const repositorySchema = z.looseObject({
  id: z.number().int().nonnegative(),
  path_with_namespace: z.string().min(1),
  name: z.string().min(1),
  default_branch: z.string().min(1).nullable().optional(),
})

/** Runtime OAuth settings and credential references. */
export interface GongfengOAuthConfig {
  readonly baseUrl: string
  readonly clientId: string
  readonly redirectUri: string
  readonly expiresAt?: number
  readonly accessTokenRef: string
  readonly refreshTokenRef: string
}

/** One bounded OAuth repository-file read. */
export interface GongfengOAuthFileRequest {
  readonly config: GongfengOAuthConfig
  readonly repository: string
  readonly path: string
  readonly ref: string
  readonly maxBytes: number
}

/** One bounded Gongfeng v3 raw-file read. */
export interface GongfengOAuthRawFileRequest {
  readonly config: GongfengOAuthConfig
  readonly repository: string
  readonly commitId: string
  readonly path: string
  readonly maxBytes: number
}

interface Flow {
  readonly id: string
  readonly state: string
  readonly verifier: string
  readonly config: GongfengOAuthConfig
  readonly expiresAt: number
  authorization: MarketplaceOAuthStatus
}

/**
 * Validate a Gongfeng OAuth origin before attaching credentials.
 * @param value Candidate Gongfeng base URL.
 * @returns Parsed HTTPS origin without credentials, path, query, or fragment.
 */
export function validateOAuthBaseUrl(value: string): URL {
  const url = new URL(value)
  if (url.origin !== new URL(GONGFENG_ORIGIN).origin || url.protocol !== 'https:' || url.username !== '' || url.password !== ''
    || url.search !== '' || url.hash !== '' || !['', '/'].includes(url.pathname)) {
    throw new Error('marketplace OAuth base URL must be an HTTPS origin')
  }
  return url
}

/**
 * Derive an RFC 7636 S256 challenge from a verifier.
 * @param verifier URL-safe PKCE verifier.
 * @returns URL-safe unpadded SHA-256 challenge.
 */
export function pkceChallenge(verifier: string): string {
  return createHash('sha256').update(verifier).digest('base64url')
}

async function boundedBytes(response: Response, maxBytes: number): Promise<Buffer> {
  const declared = response.headers.get('content-length')
  if (declared !== null && Number(declared) > maxBytes) {
    throw new Error('marketplace OAuth response exceeded its byte limit')
  }
  if (response.body === null) return Buffer.alloc(0)
  const reader = response.body.getReader()
  const chunks: Buffer[] = []
  let total = 0
  while (true) {
    const chunkRead = await reader.read()
    if (chunkRead.done) break
    total += chunkRead.value.length
    if (total > maxBytes) {
      await reader.cancel()
      throw new Error('marketplace OAuth response exceeded its byte limit')
    }
    chunks.push(Buffer.from(chunkRead.value))
  }
  return Buffer.concat(chunks, total)
}

async function boundedText(response: Response, maxBytes: number): Promise<string> {
  return (await boundedBytes(response, maxBytes)).toString('utf8')
}

/** Owns one-process PKCE state, token refresh, and Gongfeng API reads. */
export class GongfengOAuthController {
  private readonly flows = new Map<string, Flow>()
  private readonly stateToFlow = new Map<string, string>()
  private refreshPromise: Promise<string> | undefined
  private readonly lifetime = new AbortController()

  constructor(
    private readonly credentials: CredentialProvider,
    private readonly updateExpiry: (expiresAt: number) => Promise<void>,
  ) {}

  /**
   * Start one OAuth authorization using fresh state and PKCE values.
   * @param config Public client and redirect configuration.
   * @returns Browser authorization URL and polling identity.
   */
  begin(config: GongfengOAuthConfig): MarketplaceOAuthStart {
    this.lifetime.signal.throwIfAborted()
    const origin = validateOAuthBaseUrl(config.baseUrl)
    if (!/^[A-Za-z0-9_-]{8,128}$/.test(config.clientId)) throw new Error('marketplace OAuth client ID is invalid')
    this.pruneFlows()
    const id = randomUUID()
    const state = randomBytes(32).toString('base64url')
    const verifier = randomBytes(64).toString('base64url')
    const flow: Flow = {
      id,
      state,
      verifier,
      config,
      expiresAt: Date.now() + FLOW_LIFETIME_MS,
      authorization: { status: 'pending' },
    }
    this.flows.set(id, flow)
    this.stateToFlow.set(state, id)
    const url = new URL('/oauth/authorize', origin)
    url.searchParams.set('client_id', config.clientId)
    url.searchParams.set('redirect_uri', config.redirectUri)
    url.searchParams.set('response_type', 'code')
    url.searchParams.set('state', state)
    url.searchParams.set('code_challenge', pkceChallenge(verifier))
    url.searchParams.set('code_challenge_method', 'S256')
    return { flowId: id, authorizationUrl: url.href }
  }

  /**
   * Read one flow without exposing its verifier, state, code, or tokens.
   * @param flowId Identity returned from {@link begin}.
   * @returns Current authorization status.
   */
  status(flowId: string): MarketplaceOAuthStatus {
    this.pruneFlows()
    return this.flows.get(flowId)?.authorization ?? { status: 'failed', message: 'OAuth authorization expired' }
  }

  /**
   * Consume one loopback callback and exchange its code through PKCE.
   * @param callbackUrl Callback request URL.
   */
  async callback(callbackUrl: URL): Promise<void> {
    const state = callbackUrl.searchParams.get('state')
    if (state === null) throw new Error('OAuth callback is missing state')
    const id = this.stateToFlow.get(state)
    const flow = id === undefined ? undefined : this.flows.get(id)
    if (flow === undefined || flow.expiresAt <= Date.now() || flow.authorization.status !== 'pending') {
      throw new Error('OAuth callback state is invalid or expired')
    }
    this.stateToFlow.delete(state)
    const code = callbackUrl.searchParams.get('code')
    if (code === null) {
      flow.authorization = { status: 'failed', message: 'OAuth authorization was denied or returned no code' }
      throw new Error('OAuth callback is missing code')
    }
    try {
      const token = await this.exchange(flow.config, new URLSearchParams({
        client_id: flow.config.clientId,
        code,
        grant_type: 'authorization_code',
        redirect_uri: flow.config.redirectUri,
        expires_in: '7200',
        code_verifier: flow.verifier,
      }))
      await this.storeToken(flow.config, token)
      flow.authorization = { status: 'complete' }
    } catch (error) {
      flow.authorization = { status: 'failed', message: error instanceof Error ? error.message : String(error) }
      throw error
    }
  }

  /**
   * Resolve a current OAuth access token, refreshing it before expiry.
   * @param config Current public OAuth and credential configuration.
   * @param forceRefresh Whether to refresh even when the recorded expiry is current.
   * @returns Access token, or `undefined` when OAuth is not configured.
   */
  async accessToken(config: GongfengOAuthConfig, forceRefresh = false): Promise<string | undefined> {
    const current = await this.credentials.resolve(credentialRef(config.accessTokenRef))
    if (current === undefined) return undefined
    if (!forceRefresh && (config.expiresAt === undefined || config.expiresAt > Date.now() + 60_000)) {
      return current.value
    }
    if (this.refreshPromise !== undefined) return await this.refreshPromise
    this.refreshPromise = this.refresh(config).finally(() => { this.refreshPromise = undefined })
    return await this.refreshPromise
  }

  /** Read the selected project only, including its default branch. */
  async repository(config: GongfengOAuthConfig, repository: string): Promise<MarketplaceRepository> {
    const url = new URL(`/api/v3/projects/${encodeURIComponent(repository)}`, validateOAuthBaseUrl(config.baseUrl))
    const response = await this.fetch(config, url)
    const entry = repositorySchema.parse(JSON.parse(await boundedText(response, API_RESPONSE_BYTES)))
    if (entry.path_with_namespace !== repository) throw new Error('Gongfeng returned a different repository')
    return { id: entry.id, path: entry.path_with_namespace, name: entry.name,
      ...(entry.default_branch == null ? {} : { defaultBranch: entry.default_branch }) }
  }

  /** Stop pending network work and invalidate callbacks when the owning plugin unloads. */
  dispose(): void {
    this.lifetime.abort()
    this.flows.clear()
    this.stateToFlow.clear()
  }

  private request(url: URL, options: RequestInit = {}): Promise<Response> {
    return globalThis.fetch(url, { ...options, redirect: 'error',
      signal: AbortSignal.any([this.lifetime.signal, AbortSignal.timeout(30_000)]) })
  }

  /**
   * Read a repository file with the OAuth header required by Gongfeng.
   * @param request OAuth settings, repository identity, path, ref, and byte bound.
   * @returns Raw Gongfeng repository-file JSON bytes.
   */
  async repositoryFile(request: GongfengOAuthFileRequest): Promise<Buffer> {
    const url = new URL(
      `/api/v3/projects/${encodeURIComponent(request.repository)}/repository/files`,
      validateOAuthBaseUrl(request.config.baseUrl),
    )
    url.searchParams.set('file_path', request.path)
    url.searchParams.set('ref', request.ref)
    const response = await this.fetch(request.config, url)
    return await boundedBytes(response, request.maxBytes)
  }

  /**
   * Read repository file bytes through Gongfeng v3's raw endpoint.
   * @param request OAuth settings, repository, commit, path, and byte bound.
   * @returns Raw file bytes.
   */
  async repositoryRawFile(request: GongfengOAuthRawFileRequest): Promise<Buffer> {
    const url = new URL(
      `/api/v3/projects/${encodeURIComponent(request.repository)}/repository/blobs/${encodeURIComponent(request.commitId)}`,
      validateOAuthBaseUrl(request.config.baseUrl),
    )
    url.searchParams.set('filepath', request.path)
    return await boundedBytes(await this.fetch(request.config, url), request.maxBytes)
  }

  private async fetch(config: GongfengOAuthConfig, url: URL): Promise<Response> {
    let token = await this.accessToken(config)
    if (token === undefined) throw new Error('marketplace OAuth authorization is not configured')
    let response = await this.request(url, { headers: { 'OAUTH-TOKEN': token } })
    if (response.status === 401) {
      token = await this.accessToken(config, true) ?? token
      response = await this.request(url, { headers: { 'OAUTH-TOKEN': token } })
    }
    if (response.status === 429) {
      const retryAfter = response.headers.get('retry-after')?.trim()
      await response.body?.cancel()
      throw new Error(retryAfter === undefined || retryAfter === ''
        ? 'marketplace Gongfeng API rate limit exceeded; wait before retrying'
        : `marketplace Gongfeng API rate limit exceeded; retry after ${retryAfter}${/^\d+$/u.test(retryAfter) ? ' seconds' : ''}`)
    }
    if (!response.ok) {
      await response.body?.cancel()
      throw new Error(`marketplace Gongfeng API failed with ${String(response.status)}`)
    }
    return response
  }

  private async refresh(config: GongfengOAuthConfig): Promise<string> {
    const refresh = await this.credentials.resolve(credentialRef(config.refreshTokenRef))
    if (refresh === undefined) throw new Error('marketplace OAuth refresh token is unavailable')
    const token = await this.exchange(config, new URLSearchParams({
      client_id: config.clientId,
      grant_type: 'refresh_token',
      refresh_token: refresh.value,
      redirect_uri: config.redirectUri,
      expires_in: '7200',
    }))
    await this.storeToken(config, token)
    return token.access_token
  }

  private async exchange(config: GongfengOAuthConfig, body: URLSearchParams): Promise<z.infer<typeof tokenSchema>> {
    const url = new URL('/oauth/token', validateOAuthBaseUrl(config.baseUrl))
    const response = await this.request(url, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body,
    })
    const text = await boundedText(response, TOKEN_RESPONSE_BYTES)
    if (!response.ok) throw new Error(`marketplace OAuth token exchange failed with ${String(response.status)}`)
    return tokenSchema.parse(JSON.parse(text))
  }

  private async storeToken(config: GongfengOAuthConfig, token: z.infer<typeof tokenSchema>): Promise<void> {
    this.lifetime.signal.throwIfAborted()
    await this.credentials.set(credentialRef(config.refreshTokenRef), token.refresh_token)
    await this.credentials.set(credentialRef(config.accessTokenRef), token.access_token)
    await this.updateExpiry(Date.now() + token.expires_in * 1000)
  }

  private pruneFlows(): void {
    const now = Date.now()
    for (const [id, flow] of this.flows) {
      if (flow.expiresAt > now) continue
      this.flows.delete(id)
      this.stateToFlow.delete(flow.state)
    }
  }
}
