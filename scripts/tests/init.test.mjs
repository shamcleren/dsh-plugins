import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { spawnSync, execFileSync } from 'node:child_process'
import { cp, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

const repository = new URL('../../', import.meta.url)
const quote = value => "'" + value.replaceAll("'", "'\\''") + "'"
const command = name => execFileSync('/bin/sh', ['-c', 'command -v ' + name], { encoding: 'utf8' }).trim()

async function fixture(t, { node = 'missing', npm = false, platform = 'Linux', architecture = 'x86_64' } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-init-test-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const repo = join(root, 'repo with spaces'), bin = join(root, 'bin'), temporary = join(root, 'tmp')
  for (const dir of [join(repo, 'scripts'), join(repo, 'runtime'), bin, temporary]) await mkdir(dir, { recursive: true })
  await cp(new URL('../init.sh', import.meta.url), join(repo, 'scripts/init.sh'))
  await cp(new URL('Makefile', repository), join(repo, 'Makefile'))
  for (const name of ['dirname', 'awk', 'tar', 'mktemp', 'rm', 'shasum']) await symlink(command(name), join(bin, name))
  const script = (path, body) => writeFile(path, '#!/bin/sh\n' + body + '\n', { mode: 0o755 })
  await script(join(bin, 'uname'), 'case "$1" in -s) echo ' + platform + ' ;; -m) echo ' + architecture + ' ;; esac')
  if (node !== 'missing') await script(join(bin, 'node'), node === 'old' ? 'exit 1' : 'exec ' + quote(process.execPath) + ' "$@"')
  if (npm) await script(join(bin, 'npm'), 'echo 11.0.0')
  const archiveName = 'node-v24.19.0-linux-x64'
  const source = join(root, archiveName)
  await mkdir(join(source, 'bin'), { recursive: true })
  await script(join(source, 'bin/node'), 'exec ' + quote(process.execPath) + ' "$@"')
  await script(join(source, 'bin/npm'), 'echo 11.0.0')
  const archive = join(root, archiveName + '.tar.gz')
  execFileSync(command('tar'), ['-czf', archive, '-C', root, archiveName])
  const hash = createHash('sha256').update(await readFile(archive)).digest('hex')
  await writeFile(join(repo, 'runtime/node-release.sha256'), hash + '  ' + archiveName + '.tar.gz\n')
  await script(join(bin, 'curl'), 'printf "%s\\n" "$*" >> "$DOWNLOAD_LOG"\n[ "${FAIL_DOWNLOAD:-0}" = 0 ] || exit 22\nwhile [ "$1" != -o ]; do shift; done\n/bin/cp "$TEST_ARCHIVE" "$2"')
  await writeFile(join(repo, 'scripts/bootstrap.mjs'), `
    import { writeFileSync, existsSync } from 'node:fs';
    writeFileSync(process.env.RESULT, JSON.stringify({ args: process.argv.slice(2), source: process.env.DSH_BOOTSTRAP_NODE_ROOT,
      sourceExists: existsSync(process.env.DSH_BOOTSTRAP_NODE_ROOT ?? '/nonexistent'), path: process.env.PATH }));
    process.exit(Number(process.env.BOOTSTRAP_EXIT ?? 0));
  `)
  const env = { PATH: bin, HOME: root, TMPDIR: temporary, LANG: 'en_US.UTF-8', RESULT: join(root, 'result.json'),
    TEST_ARCHIVE: archive, DOWNLOAD_LOG: join(root, 'downloads') }
  const run = (args = [], extra = {}) => spawnSync('/bin/sh', [join(repo, 'scripts/init.sh'), ...args], { env: { ...env, ...extra }, encoding: 'utf8', timeout: 10000 })
  return { root, repo, bin, env, run, temporary, archive,
    result: async () => JSON.parse(await readFile(env.RESULT, 'utf8')) }
}

test('compatible system Node and npm are reused without downloading', async t => {
  const f = await fixture(t, { node: 'compatible', npm: true })
  const run = f.run(['--dir', '/example/path with spaces'], { DSH_BOOTSTRAP_NODE_ROOT: '/stale', DSH_INIT_MARKETPLACE: '1' })
  assert.equal(run.status, 0, run.stderr)
  assert.deepEqual((await f.result()).args, ['--with-marketplace', '--dir', '/example/path with spaces'])
  assert.equal((await f.result()).source, undefined)
  await assert.rejects(readFile(f.env.DOWNLOAD_LOG), { code: 'ENOENT' })
})

for (const options of [{}, { node: 'old', npm: true }, { node: 'compatible' }]) {
  test(`missing/incompatible prerequisites use verified private Node (${JSON.stringify(options)})`, async t => {
    const f = await fixture(t, options)
    const run = f.run(['--no-app'])
    assert.equal(run.status, 0, run.stderr)
    const result = await f.result()
    assert.equal(result.sourceExists, true)
    assert.ok(result.path.startsWith(result.source + '/bin:'))
    assert.match(await readFile(f.env.DOWNLOAD_LOG, 'utf8'), /https:\/\/nodejs.org\/dist\/v24\.19\.0\//)
    assert.deepEqual(await readdir(f.temporary), [])
  })
}

test('a checksum mismatch cannot execute the downloaded archive', async t => {
  const f = await fixture(t)
  await writeFile(f.archive, 'tampered')
  const run = f.run()
  assert.equal(run.status, 1)
  assert.match(run.stderr, /SHA-256 mismatch/)
  await assert.rejects(f.result(), { code: 'ENOENT' })
  assert.deepEqual(await readdir(f.temporary), [])
})

test('download and bootstrap failures preserve their exit status and clean temporary files', async t => {
  const f = await fixture(t)
  assert.equal(f.run([], { FAIL_DOWNLOAD: '1' }).status, 22)
  assert.deepEqual(await readdir(f.temporary), [])
  assert.equal(f.run([], { BOOTSTRAP_EXIT: '17' }).status, 17)
  assert.deepEqual(await readdir(f.temporary), [])
})

test('missing macOS developer tools fail before any download; help needs neither Node nor tools', async t => {
  const f = await fixture(t, { platform: 'Darwin', architecture: 'arm64' })
  assert.match(f.run().stderr, /xcode-select --install/)
  assert.equal(f.run(['--help']).status, 0)
  await assert.rejects(readFile(f.env.DOWNLOAD_LOG), { code: 'ENOENT' })
})

test('make init passes paths and opt-in flags without requiring Node on PATH', async t => {
  const f = await fixture(t)
  const dir = join(f.root, "install 'with spaces'")
  const run = spawnSync(command('make'), ['init', 'DIR=' + dir, 'WEB_ONLY=1', 'MARKETPLACE=1', 'RESUME=1', 'REBUILD=1'], {
    cwd: f.repo, env: f.env, encoding: 'utf8', timeout: 10000,
  })
  assert.equal(run.status, 0, run.stderr)
  assert.deepEqual((await f.result()).args, ['--rebuild-app', '--resume', '--with-marketplace', '--no-app', '--dir', dir])
  assert.equal(f.run([], { DSH_INIT_WEB_ONLY: 'maybe' }).status, 1)
})

test('unsupported OS and download architectures fail without making requests', async t => {
  const f = await fixture(t, { platform: 'FreeBSD' })
  assert.match(f.run().stderr, /Only macOS and Linux/)
  const other = await fixture(t, { architecture: 's390x' })
  assert.match(other.run().stderr, /arm64 and x64/)
  await assert.rejects(readFile(other.env.DOWNLOAD_LOG), { code: 'ENOENT' })
})
