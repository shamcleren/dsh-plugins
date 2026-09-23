/** Repository addresses accepted by the Git repository marketplace. */
export const GONGFENG_ORIGIN = 'https://gitlab.example.com/'
export const GITHUB_ORIGIN = 'https://github.com/'
export const DEFAULT_REPOSITORY_URL = 'https://gitlab.example.com/shamcleren/dsh-plugin'

export type RepositoryHost = 'gongfeng' | 'github'

const ORIGINS: Record<string, { host: RepositoryHost; baseUrl: string }> = {
  'https://gitlab.example.com': { host: 'gongfeng', baseUrl: GONGFENG_ORIGIN },
  'https://github.com': { host: 'github', baseUrl: GITHUB_ORIGIN },
}

export interface RepositoryAddress {
  readonly host: RepositoryHost
  readonly baseUrl: string
  readonly repository: string
  readonly repositoryUrl: string
}

export function parseRepositoryUrl(value: string): RepositoryAddress {
  const text = value.trim()
  const url = new URL(text)
  const known = ORIGINS[url.origin]
  // Tokens for one host must never be attached to the other.
  if (known === undefined || url.username || url.password || url.search || url.hash ||
      /[%\\\u0000-\u0020]/u.test(text)) throw new Error('Use an HTTPS repository address on gitlab.example.com or github.com')
  const repository = url.pathname.replace(/^\//u, '').replace(/\/$/u, '').replace(/\.git$/u, '')
  const segments = repository.split('/')
  const depth = known.host === 'github' ? segments.length === 2 : segments.length >= 2
  if (!depth || segments.some(segment => !/^[A-Za-z0-9_-][A-Za-z0-9_.-]*$/u.test(segment)) ||
      text.split('/').some(segment => segment === '.' || segment === '..')) throw new Error('Use the repository home URL, without a file or branch path')
  return { host: known.host, baseUrl: known.baseUrl, repository, repositoryUrl: known.baseUrl + repository }
}

/** Host of a typed address, or undefined while the address is incomplete. */
export function repositoryHost(value: string): RepositoryHost | undefined {
  try { return parseRepositoryUrl(value).host } catch { return undefined }
}
