import { afterEach, expect, it, vi } from 'vitest'
import { githubFile, githubRepository } from '../src/github.ts'

afterEach(() => { vi.unstubAllGlobals() })

function json(body: unknown, status = 200, headers?: HeadersInit): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } })
}

it('reads a public repository default branch without an authorization header', async () => {
  const fetch = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
    expect(new Headers(init?.headers).has('authorization')).toBe(false)
    return json({ default_branch: 'main' })
  })
  vi.stubGlobal('fetch', fetch)
  await expect(githubRepository('shamcleren/dsh-plugins')).resolves.toEqual({ defaultBranch: 'main' })
  expect(String(fetch.mock.calls[0]?.[0])).toBe('https://api.github.com/repos/shamcleren/dsh-plugins')
})

it('downloads a public file only from a GitHub content host and checks its size', async () => {
  const catalog = Buffer.from('{"schemaVersion":1,"plugins":[]}')
  const fetch = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input)
    if (url.startsWith('https://api.github.com/repos/shamcleren/dsh-plugins/contents/')) {
      return json({ type: 'file', size: catalog.length, download_url: 'https://raw.githubusercontent.com/shamcleren/dsh-plugins/main/marketplace.json' })
    }
    expect(url).toBe('https://raw.githubusercontent.com/shamcleren/dsh-plugins/main/marketplace.json')
    return new Response(catalog)
  })
  vi.stubGlobal('fetch', fetch)
  await expect(githubFile('shamcleren/dsh-plugins', 'marketplace.json', 'main', 1024)).resolves.toEqual(catalog)
})

it('refuses a redirect away from GitHub and a private repository', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 302, headers: { location: 'https://evil.example/file' } })))
  await expect(githubRepository('shamcleren/dsh-plugins')).rejects.toThrow(/refused a GitHub address/)
  vi.stubGlobal('fetch', vi.fn(async () => new Response('missing', { status: 404 })))
  await expect(githubFile('shamcleren/private', 'marketplace.json', 'main', 1024)).rejects.toThrow(/not publicly readable/)
})
