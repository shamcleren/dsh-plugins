import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { dependencies, scanDependencies, scanSecrets } from '../src/engines.js'
import { prepareSource } from '../src/repository.js'
import { audit } from '../src/workflow.js'
import { readEvidence } from '../src/evidence.js'

const roots: string[] = []
afterEach(async () => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })
async function fixture() { const root = await mkdtemp(join(tmpdir(), 'security-engines-')); roots.push(root); const target = join(root, 'repo'); await mkdir(target); return { root, target } }
it('parses locked npm, Go and Python dependencies and labels unsupported manifests', async () => {
  const f = await fixture()
  await writeFile(join(f.target, 'package-lock.json'), JSON.stringify({ lockfileVersion: 3, packages: { '': { version: '1.0.0' }, 'node_modules/@scope/pkg': { version: '1.2.3' } } }))
  await writeFile(join(f.target, 'go.sum'), 'golang.org/x/net v0.1.0 h1:fixture\n')
  await writeFile(join(f.target, 'requirements.txt'), 'Django==2.0.0\nrequests>=2\n')
  const source = await prepareSource({ target: f.target, scope: 'full', signal: new AbortController().signal })
  try {
    const result = await dependencies(source.current)
    expect(result.packages.map(dep => dep.ecosystem)).toEqual(expect.arrayContaining(['npm', 'Go', 'PyPI']))
    expect(result.unsupported).toEqual(['requirements.txt'])
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({ results: result.packages.map(() => ({ vulns: [{ id: 'TEST-2026-1' }] })) })))
    vi.stubGlobal('fetch', fetcher)
    const scanned = await scanDependencies(source.current, new AbortController().signal)
    expect(scanned.findings).toHaveLength(3)
    expect(scanned.engine.status).toBe('partial')
    const body = JSON.parse(String(fetcher.mock.calls[0]![1]!.body))
    expect(Object.keys(body.queries[0])).toEqual(['package', 'version'])
    expect(JSON.stringify(body)).not.toContain('requirements.txt')
  } finally { await source.dispose() }
})
it('keeps OSV pagination and query failures visible instead of reporting a clean scan', async () => {
  const f = await fixture(); await writeFile(join(f.target, 'requirements.txt'), 'Django==2.0.0\n')
  const source = await prepareSource({ target: f.target, scope: 'full', signal: new AbortController().signal })
  try {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ results: [{ next_page_token: 'more', vulns: [] }] }))))
    expect((await scanDependencies(source.current, new AbortController().signal)).engine.status).toBe('partial')
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')))
    expect((await scanDependencies(source.current, new AbortController().signal)).engine.status).toBe('failed')
  } finally { await source.dispose() }
})
it('redacts secret detector output and never accepts its raw messages or secret values', async () => {
  const f = await fixture(); await writeFile(join(f.target, '.env'), 'SYNTHETIC=test-not-real\n')
  const binary = join(f.root, 'gitleaks')
  await writeFile(binary, '#!' + process.execPath + '\nconst fs=require("fs");if(process.argv[2]==="version")console.log("8.24.2");else{fs.writeFileSync(process.argv[process.argv.indexOf("--report-path")+1],JSON.stringify([{RuleID:"fixture-rule",File:".env",StartLine:1,Secret:"never-expose",Match:"never-expose"}]));process.exitCode=1}', { mode: 0o700 })
  const source = await prepareSource({ target: f.target, scope: 'full', signal: new AbortController().signal })
  try {
    vi.stubEnv('PATH', f.root + ':' + (process.env.PATH ?? ''))
    const result = await scanSecrets(source.current, f.target, 'gitleaks', new AbortController().signal)
    expect(result.engine.status).toBe('completed')
    expect(result.findings).toHaveLength(1)
    expect(JSON.stringify(result)).not.toContain('never-expose')
  } finally { await source.dispose() }
})
it('evidence reads are bounded to recorded files and reject modified source', async () => {
  const f = await fixture(); await writeFile(join(f.target, 'app.py'), 'print("hello")\n')
  const result = await audit({ target: f.target, engine: 'inventory', output: join(f.root, 'reports'), signal: new AbortController().signal })
  const evidence = await readEvidence(result.json, [{ file: 'app.py', start: 1, count: 1 }], f.target, new AbortController().signal)
  expect(evidence.evidence[0]?.content).toContain('print("hello")')
  await expect(readEvidence(result.json, [{ file: '../outside' }], f.target, new AbortController().signal)).rejects.toThrow('not in')
  await writeFile(join(f.target, 'app.py'), 'changed')
  await expect(readEvidence(result.json, [{ file: 'app.py' }], f.target, new AbortController().signal)).rejects.toThrow('changed')
})

it('resolves advisory aliases and repair versions once per ID and preserves exact manifest lines', async () => {
  const f = await fixture(); await mkdir(join(f.target, 'sub'))
  for (const file of ['requirements.txt', 'sub/requirements.txt']) await writeFile(join(f.target, file), '# deps\n\nmistune==3.1.4\n')
  const fetcher = vi.fn<typeof fetch>(async (url) => new Response(JSON.stringify(String(url).endsWith('querybatch') ? { results: [{ vulns: [{ id: 'GHSA-test' }, { id: 'PYSEC-test' }] }] } : { id: String(url).split('/').at(-1), aliases: ['CVE-test'], summary: 'Example parser issue', affected: [{ package: { name: 'mistune', ecosystem: 'PyPI' }, ranges: [{ type: 'ECOSYSTEM', events: [{ introduced: '0' }, { fixed: '3.9.0' }] }] }], references: [{ url: 'https://example.invalid/advisory' }] })))
  vi.stubGlobal('fetch', fetcher)
  const source = await prepareSource({ target: f.target, scope: 'full', signal: new AbortController().signal })
  try {
    const result = await scanDependencies(source.current, new AbortController().signal)
    expect(fetcher).toHaveBeenCalledTimes(3)
    expect(result.findings).toHaveLength(4)
    expect(result.findings.every(item => item.line === 3 && item.dependency?.aliases.includes('CVE-test') && item.recommendation.includes('3.9.0'))).toBe(true)
  } finally { await source.dispose() }
})
