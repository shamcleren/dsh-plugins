/** Public GitHub reads. Gongfeng credentials are never attached to these requests. */

import { z } from 'zod'

const API = 'https://api.github.com'
const ALLOWED_HOSTS = new Set(['api.github.com', 'raw.githubusercontent.com', 'objects.githubusercontent.com'])
const repositorySchema = z.object({ default_branch: z.string().min(1) })
const fileSchema = z.object({
  type: z.literal('file'),
  size: z.number().int().nonnegative(),
  download_url: z.string().url(),
})

function safePath(path: string): string {
  const segments = path.split('/').filter(segment => segment !== '')
  if (segments.length === 0 || segments.some(segment => segment === '.' || segment === '..')) {
    throw new Error('marketplace repository path is invalid')
  }
  return segments.map(segment => encodeURIComponent(segment)).join('/')
}

function safeRef(ref: string): string {
  if (ref.trim() === '' || /[\u0000-\u001f]/u.test(ref) || ref.split('/').some(segment => segment === '.' || segment === '..')) {
    throw new Error('marketplace ref is invalid')
  }
  return ref
}

async function boundedBytes(response: Response, maxBytes: number): Promise<Buffer> {
  const declared = response.headers.get('content-length')
  if (declared !== null && Number(declared) > maxBytes) throw new Error('marketplace GitHub response exceeded its byte limit')
  if (response.body === null) return Buffer.alloc(0)
  const reader = response.body.getReader()
  const chunks: Buffer[] = []
  let total = 0
  while (true) {
    const chunk = await reader.read()
    if (chunk.done) break
    total += chunk.value.byteLength
    if (total > maxBytes) {
      await reader.cancel()
      throw new Error('marketplace GitHub response exceeded its byte limit')
    }
    chunks.push(Buffer.from(chunk.value))
  }
  return Buffer.concat(chunks, total)
}

async function githubFetch(url: URL, maxBytes: number, redirects = 0): Promise<Response> {
  if (url.protocol !== 'https:' || !ALLOWED_HOSTS.has(url.host)) throw new Error('marketplace refused a GitHub address')
  const response = await fetch(url, {
    method: 'GET',
    redirect: 'manual',
    headers: {
      accept: 'application/vnd.github+json',
      'user-agent': 'dsh-plugin-marketplace',
      'x-github-api-version': '2022-11-28',
    },
    signal: AbortSignal.timeout(30_000),
  })
  if (response.status >= 300 && response.status < 400) {
    const location = response.headers.get('location')
    if (redirects >= 3 || location === null) throw new Error('marketplace refused a GitHub redirect')
    return githubFetch(new URL(location, url), maxBytes, redirects + 1)
  }
  if (response.status === 404) throw new Error('GitHub repository is not publicly readable')
  if (response.status === 403 || response.status === 429) throw new Error('GitHub API rate limit exceeded; retry later')
  if (!response.ok) throw new Error(`marketplace GitHub API failed with ${String(response.status)}`)
  return response
}

/** Read the default branch of one public GitHub repository. */
export async function githubRepository(repository: string): Promise<{ defaultBranch: string }> {
  const response = await githubFetch(new URL(`${API}/repos/${repository}`), 256 * 1024)
  const body = repositorySchema.parse(JSON.parse((await boundedBytes(response, 256 * 1024)).toString('utf8')))
  return { defaultBranch: safeRef(body.default_branch) }
}

/** Read one public file, following only GitHub content hosts. */
export async function githubFile(repository: string, path: string, ref: string, maxBytes: number): Promise<Buffer> {
  const metaUrl = new URL(`${API}/repos/${repository}/contents/${safePath(path)}`)
  metaUrl.searchParams.set('ref', safeRef(ref))
  const listed = await githubFetch(metaUrl, 1024 * 1024)
  const file = fileSchema.parse(JSON.parse((await boundedBytes(listed, 1024 * 1024)).toString('utf8')))
  if (file.size > maxBytes) throw new Error('marketplace repository file exceeds its byte limit')
  const download = new URL(file.download_url)
  if (download.protocol !== 'https:' || !ALLOWED_HOSTS.has(download.host)) throw new Error('marketplace refused a GitHub download')
  const body = await githubFetch(download, maxBytes)
  const bytes = await boundedBytes(body, maxBytes)
  if (bytes.length !== file.size) throw new Error('marketplace GitHub file size does not match its metadata')
  return bytes
}
