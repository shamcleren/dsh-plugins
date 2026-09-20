import { execFileSync } from 'node:child_process'
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { audit, compare } from '../src/workflow.js'
import { prepareSource, validateRepositoryUrl } from '../src/repository.js'
import { readEvidence } from '../src/evidence.js'
import { exitCode, readReport, renderReport, reviewReport, sarif } from '../src/report.js'
import { manageHook, AuditQueue } from '../src/hooks.js'

const roots: string[] = []
afterEach(async () => { vi.useRealTimers(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })
const signal = (): AbortSignal => new AbortController().signal
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'security-flow-')); roots.push(root)
  const target = join(root, 'repo'); await mkdir(target)
  const git = (...args: string[]): string => execFileSync('/usr/bin/git', ['-c', 'core.hooksPath=/dev/null', ...args], { cwd: target, encoding: 'utf8', env: { PATH: '/usr/bin:/bin', HOME: root, GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 'test@example.invalid', GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 'test@example.invalid' } }).trim()
  git('init', '-q'); await writeFile(join(target, 'app.py'), 'eval(old_input)\n'); git('add', '.'); git('commit', '-qm', 'baseline')
  const binary = join(root, 'semgrep')
  await writeFile(binary, '#!' + process.execPath + '\nconst fs=require("fs"); if(process.argv.includes("--version"))console.log("1.176.1");else {const files=fs.readdirSync(process.cwd()).filter(f=>f.endsWith(".py"));const results=files.flatMap(file=>fs.readFileSync(file,"utf8").split("\\n").flatMap((line,i)=>line.includes("eval(")?[{check_id:"dsh-security.python-eval",path:file,start:{line:i+1}}]:[]));console.log(JSON.stringify({results,errors:[],paths:{scanned:files}}));}\n', { mode: 0o700 })
  return { root, target, git, binary, options: { target, semgrepPath: binary, output: join(root, 'reports'), signal: signal() } }
}
it('writes canonical JSON and offline HTML; diffs preserve historical findings across line shifts', async () => {
  const f = await fixture(), original = await audit(f.options)
  await writeFile(join(f.target, 'app.py'), '# inserted line\neval(old_input)\neval(new_input)\n')
  const result = await audit({ ...f.options, scope: 'diff', base: 'HEAD' })
  expect(result.report.findings.map(item => item.change)).toEqual(['existing', 'new'])
  expect(result.report.baseline?.comparable).toBe(true)
  expect(await readReport(result.json)).toEqual(result.report)
  expect(await readFile(result.html, 'utf8')).toContain('代码安全扫描报告')
  expect(await readFile(original.json, 'utf8')).not.toContain('new_input')
  expect(await readdir(f.options.output)).toHaveLength(2)
  expect(exitCode(result.report)).toBe(0)
  const { version } = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))
  expect(result.report.pluginVersion).toBe(version)
  const reviewed = await reviewReport(result.json, [], f.options.output)
  expect((await readReport(reviewed.json)).pluginVersion).toBe(version)
})
it('staged scans use the index and do not accidentally scan unstaged changes', async () => {
  const f = await fixture()
  await writeFile(join(f.target, 'app.py'), 'print("staged safe")\n'); f.git('add', 'app.py')
  await writeFile(join(f.target, 'app.py'), 'eval(unstaged_input)\n')
  const result = await audit({ ...f.options, scope: 'staged' })
  expect(result.report.findings).toEqual([])
  expect((await readEvidence(result.json, [{ file: 'app.py' }], f.target, signal())).evidence[0]?.content).toContain('staged safe')
  expect(result.report.baseline?.notObserved).toHaveLength(1)
  expect(await readFile(join(f.target, 'app.py'), 'utf8')).toContain('unstaged_input')
})
it('recognizes exact renames, new files, and deletions without declaring unobserved issues fixed', async () => {
  const f = await fixture()
  f.git('mv', 'app.py', 'renamed.py')
  const result = await audit({ ...f.options, scope: 'diff', base: 'HEAD' })
  expect(result.report.findings[0]?.change).toBe('existing')
  expect(result.report.baseline?.notObserved).toEqual([])
})
it('saved baselines must match repository, rules and complete engine coverage', async () => {
  const f = await fixture(), base = await audit(f.options)
  const next = await audit({ ...f.options, baseline: base.json })
  expect(next.report.findings[0]?.change).toBe('existing')
  expect(compare(next.report, { ...base.report, source: { ...base.report.source, identity: 'other-repo' } }).baseline?.comparable).toBe(false)
  const failed = await audit({ ...f.options, semgrepPath: join(f.root, 'missing'), baseline: base.json })
  expect(failed.report.baseline?.comparable).toBe(false)
  expect(exitCode(failed.report)).toBe(2)
})
it('preserves review history, supports extra model findings, and escapes malicious report content', async () => {
  const f = await fixture(), result = await audit(f.options)
  const first = result.report.findings[0]!
  const reviewed = await reviewReport(result.json, [{ findingId: first.id, status: 'confirmed', severity: 'high', evidence: '<script>alert(1)</script>', recommendation: 'Use a parser', verification: 'Call path inspected', reviewer: 'fixture' }], f.options.output,
    [{ file: 'app.py', line: 1, title: 'Business issue', cwe: 'CWE-862', severity: 'high', status: 'needs-review', evidence: 'Missing caller context', recommendation: 'Check caller', verification: 'Not reproduced' }])
  const report = await readReport(reviewed.json)
  expect(report.parentReport).toBe(result.report.id)
  expect(report.findings).toHaveLength(2)
  expect(report.findings[1]?.change).toBe('unknown')
  expect(renderReport(report)).not.toContain('<script>alert(1)</script>')
  expect(renderReport(report)).toContain('&lt;script&gt;alert(1)&lt;/script&gt;')
  expect((await readReport(result.json)).findings[0]?.status).toBe('needs-review')
  expect(sarif(report)).toMatchObject({ version: '2.1.0' })
  const gated = { ...report, policy: { ...report.policy, failOn: 'high' as const }, findings: report.findings.map(item => ({ ...item, change: 'new' as const })) }
  expect(exitCode(gated)).toBe(1)
  await expect(reviewReport(result.json, [], f.options.output, [{ ...report.findings[0]!, file: '../evil' }] as never)).rejects.toThrow()
})
it('rejects unsafe refs/URLs, never follows snapshot symlinks, and requires explicit diff base', async () => {
  const f = await fixture()
  for (const url of ['file:///tmp/repo', 'https://user:password@example.com/repo', 'ext::sh -c evil']) expect(() => validateRepositoryUrl(url)).toThrow()
  expect(validateRepositoryUrl('git@example.com:team/repo.git')).toBe('git@example.com:team/repo.git')
  await symlink('/etc/passwd', join(f.target, 'outside.py'))
  const snapshot = await prepareSource({ target: f.target, scope: 'full', signal: signal() })
  try { expect(snapshot.current.files['outside.py']).toBeUndefined() } finally { await snapshot.dispose() }
  await expect(audit({ ...f.options, scope: 'diff' })).rejects.toThrow('require --base')
})
it('installs only explicit owned hooks, never overwrites user hooks, and removes only its own', async () => {
  const f = await fixture()
  const options = { target: f.target, event: 'pre-commit' as const, cli: '/tmp/cli with spaces.js', output: f.options.output, semgrepPath: f.binary, enforce: false, signal: signal() }
  expect(await manageHook({ ...options, action: 'install' })).toContain('Installed')
  expect(await manageHook({ ...options, action: 'install' })).toContain('up to date')
  expect(await readFile(join(f.target, '.git/hooks/pre-commit'), 'utf8')).toContain("'staged'")
  await manageHook({ ...options, action: 'remove' })
  await writeFile(join(f.target, '.git/hooks/pre-commit'), '#!/bin/sh\necho user hook\n')
  await expect(manageHook({ ...options, action: 'install' })).rejects.toThrow('exists')
  await expect(manageHook({ ...options, action: 'remove' })).rejects.toThrow('user hook')
})
it('coalesces edits and cancels owned background work on disposal', async () => {
  vi.useFakeTimers()
  let complete!: () => void
  const run = vi.fn(async (_workspace: string, signal: AbortSignal) => new Promise<void>(resolve => { complete = resolve; signal.addEventListener('abort', () => resolve(), { once: true }) }))
  const queue = new AuditQueue(run, vi.fn(), 100)
  queue.enqueue('/repo'); queue.enqueue('/repo')
  await vi.advanceTimersByTimeAsync(100)
  expect(run).toHaveBeenCalledOnce()
  queue.enqueue('/repo'); complete(); await vi.advanceTimersByTimeAsync(101)
  expect(run).toHaveBeenCalledTimes(2)
  await queue.stop(); expect(queue.abort.signal.aborted).toBe(true)
})

it('honors nested gitignore and negation, but scans tracked ignored files and hidden source', async () => {
  const f = await fixture()
  await mkdir(join(f.target, 'nested'))
  await writeFile(join(f.target, '.gitignore'), '*.local.py\ncache/\n')
  await writeFile(join(f.target, 'nested/.gitignore'), '*.py\n!keep.py\n')
  for (const name of ['ignored.local.py', 'tracked.local.py', '.hidden.py', 'nested/skip.py', 'nested/keep.py']) await writeFile(join(f.target, name), 'eval(input())\n')
  f.git('add', '-f', 'tracked.local.py')
  const result = await audit(f.options)
  expect(Object.keys(result.report.source.files)).toEqual(expect.arrayContaining(['tracked.local.py', '.hidden.py', 'nested/keep.py']))
  expect(Object.keys(result.report.source.files)).not.toContain('ignored.local.py')
  expect(Object.keys(result.report.source.files)).not.toContain('nested/skip.py')
})

it('keeps intermediate audit data private and does not render HTML before publication', async () => {
  const f = await fixture(), result = await audit({ ...f.options, draft: true })
  expect(await readReport(result.json)).toEqual(result.report)
  await expect(readFile(result.html)).rejects.toMatchObject({ code: 'ENOENT' })
})

it('keeps redacted scan-time code offline after the workspace changes, without executable HTML injection', async () => {
  const f = await fixture()
  await writeFile(join(f.target, 'app.py'), 'api_key = "sk-12345678901234567890"\neval(value)\n# </script><script>alert(1)</script>\n')
  const result = await audit(f.options)
  const excerpt = result.report.evidenceArchive!.snippets[0]!
  expect(excerpt.start).toBe(1)
  expect(excerpt.lines[1]).toBe('eval(value)')
  expect(excerpt.redacted).toBe(true)
  expect(JSON.stringify(result.report.evidenceArchive)).not.toContain('sk-12345678901234567890')
  await writeFile(join(f.target, 'app.py'), 'changed after the scan\n')
  const html = renderReport(await readReport(result.json))
  expect(html).toContain('code-data')
  expect(html).not.toContain('vscode://')
  expect(html).not.toContain('</script><script>alert(1)</script>')
  expect((await readReport(result.json)).evidenceArchive!.snippets[0]!.lines[1]).toBe('eval(value)')
})
