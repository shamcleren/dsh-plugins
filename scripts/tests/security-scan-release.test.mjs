import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { createServer } from 'node:http'
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import test from 'node:test'
import { releaseArtifact } from '../plugins.mjs'

const repo = fileURLToPath(new URL('../../', import.meta.url)), exec = promisify(execFile)

test('packaged security CLI scans with real rules and parses uv without model credentials', { skip: !process.env.SECURITY_TEST_SEMGREP, timeout: 120000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-security-package-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const entry = JSON.parse(await readFile(join(repo, 'marketplace.json'), 'utf8')).plugins.find(item => item.id === 'security-scan')
  await releaseArtifact(repo, entry)
  await exec('tar', ['-xf', join(repo, entry.artifact.path), '-C', root])
  const pkg = join(root, 'package')
  // Dependency resolution is test-local. Official installation is verified separately by smoke-runtime.
  await symlink(join(repo, 'plugins/security-scan/node_modules'), join(pkg, 'node_modules'), 'dir')
  const entryPath = join(root, 'dsh-security')
  await symlink(join(pkg, 'lib/cli.js'), entryPath)
  const guard = join(root, 'http-guard.mjs')
  await writeFile(guard, `import { appendFile } from 'node:fs/promises';
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, options) => {
  if (process.env.SCAN_TEST_RUNTIME && String(url).startsWith(process.env.SCAN_TEST_RUNTIME)) return realFetch(url, options);
  if (String(url) !== 'https://api.osv.dev/v1/querybatch') throw new Error('Unexpected network/model request');
  const body = JSON.parse(options.body);
  if (JSON.stringify(body) !== JSON.stringify({queries:[{package:{name:'django',ecosystem:'PyPI'},version:'2.0.0'},{package:{name:'django',ecosystem:'PyPI'},version:'4.2.0'}]})) throw new Error('Unexpected dependency payload');
  await appendFile(process.env.SCAN_TEST_HTTP_LOG, JSON.stringify(body)+'\\n');
  return new Response(JSON.stringify({results:[{vulns:[]},{vulns:[]}]}));
};\n`)
  const env = { PATH: process.env.PATH, DSH_HOME: join(root, 'home'), SCAN_TEST_HTTP_LOG: join(root, 'requests.jsonl') }
  const cli = async args => {
    try { return { ...await exec(process.execPath, ['--import', guard, entryPath, ...args], { cwd: root, env, timeout: 45000, maxBuffer: 1024 * 1024 }), code: 0 } }
    catch (error) { if (typeof error.code !== 'number') throw error; return { code: error.code, stdout: error.stdout, stderr: error.stderr } }
  }
  const help = await cli(['help'])
  assert.equal(help.code, 0, help.stderr)
  assert.match(help.stdout, /dsh-security scan/)
  await assert.rejects(readFile(env.SCAN_TEST_HTTP_LOG), { code: 'ENOENT' })
  const target = join(root, 'project'), reports = join(root, 'reports')
  await mkdir(target)
  await writeFile(join(target, 'app.py'), 'print("safe fixture")\n')
  await writeFile(join(target, 'pyproject.toml'), '[project]\nname = "local-app"\n')
  await writeFile(join(target, 'uv.lock'), 'version = 1\n' + ['2.0.0', '4.2.0'].map(version => '[[package]]\nname = "Django"\nversion = "' + version + '"\nsource = { registry = "https://user:fixture-only@registry.invalid/simple" }\n').join(''))
  const scan = await cli(['scan', '--target', target, '--output', reports, '--semgrep', process.env.SECURITY_TEST_SEMGREP, '--dependencies'])
  assert.equal(scan.code, 0, scan.stderr)
  const [id] = await readdir(reports)
  const report = JSON.parse(await readFile(join(reports, id, 'report.json'), 'utf8'))
  assert.equal(report.pluginVersion, entry.version)
  assert.equal(report.agent, undefined)
  assert.equal(report.policy.secrets, false)
  assert.equal(report.coverage.scannedFiles, 1)
  assert.equal(report.engines.find(engine => engine.name === 'osv').status, 'completed')
  assert.match(report.engines.find(engine => engine.name === 'osv').detail, /uv.lock schema v1/)
  assert.equal((await readFile(env.SCAN_TEST_HTTP_LOG, 'utf8')).trim().split('\n').length, 1)
  // Packaged false-positive exclusions: the default list under DSH_HOME applies to later CLI scans until restored.
  const flagged = join(root, 'flagged'), flaggedReports = join(root, 'flagged-reports')
  await mkdir(flagged)
  await writeFile(join(flagged, 'app.py'), 'import os\ndef run(name):\n    os.system("echo " + name)\n')
  const flaggedScan = async () => {
    const before = new Set(await readdir(flaggedReports).catch(() => []))
    const result = await cli(['scan', '--target', flagged, '--output', flaggedReports, '--semgrep', process.env.SECURITY_TEST_SEMGREP])
    assert.equal(result.code, 0, result.stderr)
    const [name] = (await readdir(flaggedReports)).filter(item => !before.has(item))
    const file = join(flaggedReports, name, 'report.json')
    return { file, finding: JSON.parse(await readFile(file, 'utf8')).findings.find(item => item.rule === 'dsh-security.python-shell') }
  }
  const first = await flaggedScan()
  assert.equal(first.finding?.status, 'needs-review')
  const added = await cli(['suppress', '--action', 'add', '--report', first.file, '--finding', first.finding.id, '--reason', 'fixture command'])
  assert.equal(added.code, 0, added.stderr)
  assert.equal(JSON.parse(added.stdout).file, join(env.DSH_HOME, 'security-scan/suppressions.json'))
  const hidden = await flaggedScan()
  assert.equal(hidden.finding.status, 'dismissed')
  assert.equal(hidden.finding.suppression.reason, 'fixture command')
  const [saved] = JSON.parse((await cli(['suppress', '--action', 'list'])).stdout)
  assert.equal((await cli(['suppress', '--action', 'remove', '--id', saved.id])).code, 0)
  assert.equal((await flaggedScan()).finding.status, 'needs-review')
  // The packaged runtime baseline reaches only the authorized local origin, with GET requests and no stored bodies.
  const seen = []
  const service = createServer((request, response) => { seen.push(request.method); response.setHeader('content-type', 'text/html'); response.setHeader('set-cookie', 'sid=packaged-cookie-value'); response.statusCode = request.url === '/' ? 200 : 404; response.end('<html>packaged-body-marker</html>') })
  await new Promise(resolve => service.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise(resolve => service.close(resolve)))
  const runtime = 'http://127.0.0.1:' + service.address().port + '/', runtimeReports = join(root, 'runtime-reports')
  env.SCAN_TEST_RUNTIME = runtime
  const dynamic = await cli(['scan', '--target', target, '--output', runtimeReports, '--semgrep', process.env.SECURITY_TEST_SEMGREP, '--dynamic', runtime])
  assert.equal(dynamic.code, 0, dynamic.stderr)
  const [runtimeId] = await readdir(runtimeReports)
  const runtimeJson = await readFile(join(runtimeReports, runtimeId, 'report.json'), 'utf8'), runtimeReport = JSON.parse(runtimeJson)
  assert.equal(runtimeReport.policy.dynamic, runtime)
  assert.equal(runtimeReport.engines.find(engine => engine.name === 'http').status, 'completed')
  assert.ok(runtimeReport.findings.some(item => item.rule === 'dynamic.cookie-httponly' && item.endpoint.url === runtime))
  assert.ok(seen.length > 0 && seen.length <= 12 && seen.every(method => method === 'GET'))
  assert.doesNotMatch(runtimeJson, /packaged-cookie-value|packaged-body-marker/)
})
