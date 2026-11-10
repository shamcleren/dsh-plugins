import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, expect, it, vi } from 'vitest'
import { parseUvLock } from '../src/uv-lock.js'
import { dependencies, scanDependencies } from '../src/engines.js'
import { prepareSource } from '../src/repository.js'

const roots: string[] = []
afterEach(async () => { vi.unstubAllGlobals(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })
const registry = (name: string, version: string) => `[[package]]\nname = "${name}"\nversion = "${version}"\nsource = { registry = "https://pypi.org/simple" }\n`
async function source(text: string) {
  const target = await mkdtemp(join(tmpdir(), 'security-uv-')); roots.push(target)
  await writeFile(join(target, 'uv.lock'), text)
  await writeFile(join(target, 'pyproject.toml'), '[project]\nname = "local-app"\nversion = "1.0.0"\n')
  await mkdir(join(target, 'packages/service'), { recursive: true })
  await writeFile(join(target, 'packages/service/pyproject.toml'), '[project]\nname = "local-service"\n')
  return prepareSource({ target, scope: 'full', signal: new AbortController().signal })
}

it('parses uv v1 TOML, retains all marker versions and deduplicates normalized packages', () => {
  const result = parseUvLock('version = 1\nrevision = 5\n' + registry('Example_Pkg', '1.0.0') + 'resolution-markers = ["python_version < \'3.12\'"]\n' + registry('example-pkg', '2.0.0') + registry('example.pkg', '1.0.0') + 'description = """\n[[package]]\nname = "not-an-entry"\n"""\n')
  expect(result.packages).toEqual([{ name: 'example-pkg', version: '1.0.0' }, { name: 'example-pkg', version: '2.0.0' }])
  expect(result.unsupported).toBe(0)
})

it('uses locked registry versions while excluding local workspace identities from PyPI queries', async () => {
  const snapshot = await source('version = 1\n' + registry('Django', '2.0.0') + '[[package]]\nname = "local-app"\nversion = "1.0.0"\nsource = { editable = "." }\n[[package]]\nname = "local-service"\nsource = { virtual = "packages/service" }\n')
  try {
    const result = await dependencies(snapshot.current)
    expect(result.packages).toEqual([{ name: 'django', version: '2.0.0', ecosystem: 'PyPI', file: 'uv.lock' }])
    expect(result.unsupported).toEqual([])
    expect(result.notes.join(' ')).toContain('环境标记')
  } finally { await snapshot.dispose() }
})

it.each(['version = 2\n' + registry('django', '2.0.0'), 'version = 1\n[[package]\nname = "broken"', 'version = 1\npackage = "wrong"'])('marks invalid or unknown uv formats as partial coverage', async text => {
  const snapshot = await source(text)
  try {
    const result = await dependencies(snapshot.current)
    expect(result.packages).toEqual([])
    expect(result.unsupported).toContain('uv.lock')
    expect(result.unsupported).toContain('pyproject.toml')
  } finally { await snapshot.dispose() }
})

it('keeps valid entries while reporting VCS, archive and malformed entries without following their sources', async () => {
  const snapshot = await source('version = 1\n' + registry('django', '2.0.0') + '[[package]]\nname = "vcs-pkg"\nversion = "1.0"\nsource = { git = "https://example.invalid/private.git" }\n[[package]]\nname = "url-pkg"\nversion = "1.0"\nsource = { url = "https://example.invalid/private.whl" }\n[[package]]\nname = "missing-version"\nsource = { registry = "https://pypi.org/simple" }\n')
  const fetcher = vi.fn(() => { throw new Error('network must not be used by the parser') }); vi.stubGlobal('fetch', fetcher)
  try {
    const result = await dependencies(snapshot.current)
    expect(result.packages).toHaveLength(1)
    expect(result.unsupported).toContain('uv.lock')
    expect(result.notes.join(' ')).toContain('3 个包条目')
    expect(result.notes.join(' ')).not.toContain('example.invalid')
    expect(fetcher).not.toHaveBeenCalled()
  } finally { await snapshot.dispose() }
})

it('queries each locked package version once and sends no lockfile URLs, markers or credentials', async () => {
  const snapshot = await source('version = 1\n' + registry('Django', '2.0.0').replace('https://pypi.org/simple', 'https://user:synthetic-password@example.invalid/simple') + registry('django', '2.0.0') + registry('django', '4.2.0') + '[[package]]\nname = "local-service"\nsource = { editable = "packages/service" }\n')
  const fetcher = vi.fn<typeof fetch>(async (url, init) => {
    expect(String(url)).toBe('https://api.osv.dev/v1/querybatch')
    const queries = JSON.parse(String(init?.body)).queries
    expect(queries).toEqual([{ package: { name: 'django', ecosystem: 'PyPI' }, version: '2.0.0' }, { package: { name: 'django', ecosystem: 'PyPI' }, version: '4.2.0' }])
    return new Response(JSON.stringify({ results: queries.map(() => ({ vulns: [] })) }))
  })
  vi.stubGlobal('fetch', fetcher)
  try {
    const result = await scanDependencies(snapshot.current, new AbortController().signal)
    expect(result.engine.status).toBe('completed')
    expect(result.engine.detail).toContain('不推断当前环境')
    expect(fetcher).toHaveBeenCalledTimes(1)
  } finally { await snapshot.dispose() }
})

it('does not let a nested lock claim unrelated projects or follow workspace paths outside the snapshot', async () => {
  const snapshot = await source('version = 1\n' + registry('django', '4.2.0') + '[[package]]\nname = "external"\nsource = { editable = "../../../outside" }\n[[package]]\nname = "absolute"\nsource = { directory = "/private/unknown" }\n[[package]]\nname = "ambiguous"\nversion = "1.0"\nsource = { registry = "https://pypi.org/simple", git = "https://example.invalid/project.git" }\n')
  try {
    const result = await dependencies(snapshot.current)
    expect(result.unsupported).toContain('uv.lock')
    expect(result.unsupported).toContain('packages/service/pyproject.toml')
    expect(result.packages).toHaveLength(1)
    expect(JSON.stringify(result)).not.toContain('/private/unknown')
    expect(JSON.stringify(result)).not.toContain('example.invalid')
  } finally { await snapshot.dispose() }
})
