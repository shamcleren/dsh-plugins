/** One repository address is enough for the built-in Gongfeng OAuth client. */
export const GONGFENG_ORIGIN = 'https://gitlab.example.com/'
export const DEFAULT_REPOSITORY_URL = 'https://gitlab.example.com/shamcleren/dsh-plugin'

export function parseRepositoryUrl(value: string): { baseUrl: string; repository: string; repositoryUrl: string } {
  const text = value.trim()
  const url = new URL(text)
  // The bundled public OAuth application belongs to this origin. Never send its tokens to another host.
  if (url.origin !== new URL(GONGFENG_ORIGIN).origin || url.username || url.password || url.search || url.hash ||
      /[%\\\u0000-\u0020]/u.test(text)) throw new Error('Use an HTTPS repository address on gitlab.example.com')
  const repository = url.pathname.replace(/^\//, '').replace(/\/$/, '').replace(/\.git$/, '')
  const segments = repository.split('/')
  if (segments.length < 2 || segments.some(segment => !/^[A-Za-z0-9_-][A-Za-z0-9_.-]*$/.test(segment)) ||
      text.split('/').some(segment => segment === '.' || segment === '..')) throw new Error('Use the repository home URL, without a file or branch path')
  return { baseUrl: GONGFENG_ORIGIN, repository, repositoryUrl: GONGFENG_ORIGIN + repository }
}
