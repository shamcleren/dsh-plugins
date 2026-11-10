import { execFileSync } from 'node:child_process'
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { audit, loadSuppressions } from '../src/workflow.js'
import { exitCode, readReport, renderReport, reviewReport, sarif, type Report } from '../src/report.js'
import { addSuppressions, applySuppressions, readSuppressions, removeSuppression } from '../src/suppressions.js'
import { main } from '../src/cli.js'
import { Toolchains } from '../src/toolchains.js'

const roots: string[] = []
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })
const signal = (): AbortSignal => new AbortController().signal
/** A repository with two eval() hits and a fake Semgrep that reports every eval( line. */
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'security-suppress-')); roots.push(root)
  const target = join(root, 'repo'); await mkdir(target)
  const git = (...args: string[]): string => execFileSync('/usr/bin/git', ['-c', 'core.hooksPath=/dev/null', ...args], { cwd: target, encoding: 'utf8', env: { PATH: '/usr/bin:/bin', HOME: root, GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 'test@example.invalid', GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 'test@example.invalid' } }).trim()
  git('init', '-q'); await writeFile(join(target, 'app.py'), 'eval(trusted_constant)\neval(request_input)\n'); git('add', '.'); git('commit', '-qm', 'baseline')
  const binary = join(root, 'semgrep')
  await writeFile(binary, '#!' + process.execPath + '\nconst fs=require("fs"); if(process.argv.includes("--version"))console.log("1.176.1");else {const files=fs.readdirSync(process.cwd()).filter(f=>f.endsWith(".py"));const results=files.flatMap(file=>fs.readFileSync(file,"utf8").split("\\n").flatMap((line,i)=>line.includes("eval(")?[{check_id:"dsh-security.python-eval",path:file,start:{line:i+1}}]:[]));console.log(JSON.stringify({results,errors:[],paths:{scanned:files}}));}\n', { mode: 0o700 })
  const file = join(root, 'store', 'suppressions.json')
  return { root, target, git, file, options: { target, semgrepPath: binary, output: join(root, 'reports'), signal: signal() } }
}

it('hides an excluded finding in later scans, keeps it out of failure gates and SARIF, and survives line shifts', async () => {
  const f = await fixture(), first = await audit(f.options)
  const trusted = first.report.findings.find(item => item.line === 1)!
  expect(await addSuppressions(f.file, first.report, [trusted.id], '常量来自内部配置')).toEqual({ added: 1, existing: 0 })
  // Repeating the decision is idempotent.
  expect(await addSuppressions(f.file, first.report, [trusted.id], '重复排除')).toEqual({ added: 0, existing: 1 })

  await writeFile(join(f.target, 'app.py'), '# moved down\neval(trusted_constant)\neval(request_input)\n')
  const next = await audit({ ...f.options, failOn: 'medium', baseline: first.json, suppressions: await loadSuppressions(f.file) })
  const hidden = next.report.findings.find(item => item.line === 2)!, open = next.report.findings.find(item => item.line === 3)!
  expect(hidden).toMatchObject({ status: 'dismissed', suppression: { reason: '常量来自内部配置' }, fingerprint: trusted.fingerprint, change: 'existing' })
  expect(open.status).toBe('needs-review')
  expect(next.report.notes.some(note => note.includes('1 条问题标记为已排除'))).toBe(true)
  expect(await readReport(next.json)).toEqual(next.report)
  const html = await readFile(next.html, 'utf8')
  expect(html).toContain('标记为误报：常量来自内部配置')
  expect(html).toContain('其中 1 条按你之前的排除记录自动隐藏')
  const results = (sarif(next.report) as { runs: [{ results: { locations: [{ physicalLocation: { region: { startLine: number } } }] }[] }] }).runs[0].results
  expect(results.map(item => item.locations[0].physicalLocation.region.startLine)).toEqual([3])

  // A reviewer cannot silently overturn the user's exclusion in a later revision.
  await expect(reviewReport(next.json, [{ findingId: hidden.id, status: 'confirmed', severity: 'high', evidence: 'e', recommendation: 'r', verification: 'v', reviewer: 'x' }], f.options.output)).rejects.toThrow('excluded')

  // Only new confirmed findings fail the gate; the suppressed one would not count even if it were confirmed.
  const confirmed: Report = { ...next.report, findings: next.report.findings.map(item => ({ ...item, change: 'new' as const, status: item.suppression ? 'dismissed' as const : 'confirmed' as const })) }
  expect(exitCode(confirmed)).toBe(1)
  expect(exitCode({ ...confirmed, findings: confirmed.findings.filter(item => item.suppression) })).toBe(0)
})

it('restores a finding after its exclusion is removed and does not match other repositories or edited code', async () => {
  const f = await fixture(), first = await audit(f.options)
  await addSuppressions(f.file, first.report, first.report.findings.map(item => item.id), '测试')
  const items = await readSuppressions(f.file)
  expect(items).toHaveLength(2)
  const other = applySuppressions(first.report, items, 'another-repository')
  expect(other.findings.every(item => item.status === 'needs-review')).toBe(true)

  await writeFile(join(f.target, 'app.py'), 'eval(trusted_constant)\neval(changed_request_input)\n')
  const edited = await audit({ ...f.options, suppressions: { items } })
  expect(edited.report.findings.map(item => item.status)).toEqual(['dismissed', 'needs-review'])

  await removeSuppression(f.file, items[0]!.id)
  const restored = await audit({ ...f.options, suppressions: await loadSuppressions(f.file) })
  expect(restored.report.findings.map(item => item.status)).toEqual(['needs-review', 'needs-review'])
  await expect(removeSuppression(f.file, items[0]!.id)).rejects.toThrow('suppression-not-found')
})

it('rejects AI-only findings, unknown IDs, empty reasons, symlinked or malformed stores', async () => {
  const f = await fixture(), first = await audit(f.options)
  const ai: Report = { ...first.report, findings: [...first.report.findings, { ...first.report.findings[0]!, id: 'llm-1', engine: 'llm', rule: 'llm-context-review' }] }
  await expect(addSuppressions(f.file, ai, ['llm-1'], '原因')).rejects.toThrow('finding-not-suppressible')
  await expect(addSuppressions(f.file, first.report, ['missing'], '原因')).rejects.toThrow('unknown-finding')
  await expect(addSuppressions(f.file, first.report, [first.report.findings[0]!.id], '   ')).rejects.toThrow()

  await mkdir(join(f.root, 'store'), { recursive: true })
  await writeFile(join(f.root, 'elsewhere.json'), JSON.stringify({ owner: 'dsh-security-suppressions-v1', items: [] }))
  await symlink(join(f.root, 'elsewhere.json'), f.file)
  await expect(readSuppressions(f.file)).rejects.toThrow('unsafe-suppressions')
  await expect(addSuppressions(f.file, first.report, [first.report.findings[0]!.id], '原因')).rejects.toThrow('unsafe-suppressions')
  await rm(f.file)
  await writeFile(f.file, '{"owner":"someone-else","items":[]}')
  // A broken list never blocks the scan; the report explains that exclusions were skipped.
  const result = await audit({ ...f.options, suppressions: await loadSuppressions(f.file) })
  expect(result.report.findings.every(item => item.status === 'needs-review')).toBe(true)
  expect(result.report.notes.some(note => note.includes('排除记录无法读取'))).toBe(true)
  expect(renderReport(result.report)).toContain('排除记录无法读取')
})

it('serializes concurrent writers without losing exclusions', async () => {
  const f = await fixture(), first = await audit(f.options)
  const [a, b] = first.report.findings
  const attempts = await Promise.allSettled([addSuppressions(f.file, first.report, [a!.id], '甲'), addSuppressions(f.file, first.report, [b!.id], '乙')])
  // A writer that finds the lock held reports it instead of overwriting; retrying succeeds.
  for (const [index, attempt] of attempts.entries()) if (attempt.status === 'rejected') {
    expect(String(attempt.reason)).toContain('suppressions-locked')
    await addSuppressions(f.file, first.report, [[a, b][index]!.id], '重试')
  }
  expect((await readSuppressions(f.file)).map(item => item.fingerprint).sort()).toEqual([a!.fingerprint, b!.fingerprint].sort())
})

it('CLI scans apply the shared list by default and manage it with suppress list/add/remove', async () => {
  const f = await fixture()
  vi.spyOn(Toolchains.prototype, 'resolve').mockResolvedValue({ semgrepPath: f.options.semgrepPath, gitleaksPath: '' })
  const log = vi.spyOn(console, 'log').mockImplementation(() => {})
  const output = f.options.output
  expect(await main(['scan', '--target', f.target, '--output', output, '--suppressions', f.file])).toBe(0)
  const json = String(log.mock.calls.at(-1)?.[0]).match(/JSON: (.+)/u)![1]!
  const report = await readReport(json)
  expect(await main(['suppress', '--action', 'add', '--report', json, '--finding', report.findings[0]!.id, '--reason', '内部常量', '--suppressions', f.file])).toBe(0)
  expect(await main(['scan', '--target', f.target, '--output', output, '--suppressions', f.file, '--fail-on', 'medium'])).toBe(0)
  const second = await readReport(String(log.mock.calls.at(-1)?.[0]).match(/JSON: (.+)/u)![1]!)
  expect(second.findings.filter(item => item.suppression)).toHaveLength(1)
  await expect(main(['scan', '--target', f.target, '--output', output, '--suppressions', f.file, '--ignore-suppressions'])).rejects.toThrow('Choose either')
  expect(await main(['scan', '--target', f.target, '--output', output, '--ignore-suppressions'])).toBe(0)
  const ignored = await readReport(String(log.mock.calls.at(-1)?.[0]).match(/JSON: (.+)/u)![1]!)
  expect(ignored.findings.some(item => item.suppression)).toBe(false)
  expect(await main(['suppress', '--suppressions', f.file])).toBe(0)
  const listed = JSON.parse(String(log.mock.calls.at(-1)?.[0])) as { id: string; reason: string }[]
  expect(listed.map(item => item.reason)).toEqual(['内部常量'])
  expect(await main(['suppress', '--action', 'remove', '--id', listed[0]!.id, '--suppressions', f.file])).toBe(0)
  expect(await readSuppressions(f.file)).toEqual([])
}, 20000)
