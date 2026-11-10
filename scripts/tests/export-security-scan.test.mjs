import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { MANIFEST_NAME, assertPublicText, exportSecurityScan, parseArgs, sourceRoot } from '../export-security-scan.mjs'

async function scratch(t) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-export-security-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  return root
}

async function put(root, rel, text) {
  await mkdir(join(root, rel, '..'), { recursive: true })
  await writeFile(join(root, rel), text)
}

async function source(t, { readme = '# Security scan\n', withLib = true } = {}) {
  const root = join(await scratch(t), 'source')
  const plugin = 'plugins/security-scan/'
  await put(root, 'tsconfig.base.json', '{ "compilerOptions": { "strict": true } }\n')
  await put(root, plugin + 'package.json', '{ "name": "@shamcleren/dsh-security-scan" }\n')
  await put(root, plugin + 'tsconfig.json', JSON.stringify({ extends: '../../tsconfig.base.json', include: ['src'] }))
  await put(root, plugin + 'README.md', readme)
  await put(root, plugin + 'src/index.ts', 'export {}\n')
  await put(root, plugin + 'standalone/gitignore', 'node_modules/\n')
  await put(root, plugin + 'standalone/ci.yml', 'name: CI\n')
  await put(root, plugin + 'standalone/pnpm-lock.yaml', 'lockfileVersion: 9.0\n')
  await put(root, plugin + 'node_modules/leak.js', 'ignored\n')
  await put(root, 'plugins/other/secret.md', 'other plugin\n')
  if (withLib) for (const file of ['index.js', 'index.d.ts', 'cli.js', 'client.js', 'client/app.js']) await put(root, plugin + 'lib/' + file, '// built\n')
  await put(root, '.gitignore', 'node_modules/\nlib/\n')
  execFileSync('git', ['init', '-q', root])
  return root
}

test('exports a standalone tree with built lib, repository files and a local tsconfig base', async t => {
  const from = await source(t)
  const dest = join(await scratch(t), 'public')
  const result = await exportSecurityScan({ source: from, dest, log: () => {} })
  assert.deepEqual(result.files, [
    '.github/workflows/ci.yml', '.gitignore', 'README.md', 'lib/cli.js', 'lib/client.js', 'lib/client/app.js', 'lib/index.d.ts', 'lib/index.js',
    'package.json', 'pnpm-lock.yaml', 'src/index.ts', 'tsconfig.base.json', 'tsconfig.json',
  ])
  assert.equal(JSON.parse(await readFile(join(dest, 'tsconfig.json'), 'utf8')).extends, './tsconfig.base.json')
  assert.equal(await readFile(join(dest, 'tsconfig.base.json'), 'utf8'), '{ "compilerOptions": { "strict": true } }\n')
  await assert.rejects(readFile(join(dest, 'standalone/ci.yml')), { code: 'ENOENT' })
  await assert.rejects(readFile(join(dest, 'node_modules/leak.js')), { code: 'ENOENT' })
})

test('removes only files from the previous export and keeps the destination Git data', async t => {
  const from = await source(t)
  const dest = join(await scratch(t), 'public')
  await exportSecurityScan({ source: from, dest, log: () => {} })
  await put(dest, '.git/HEAD', 'ref: refs/heads/main\n')
  await put(dest, 'NOTES.md', 'maintainer notes\n')
  await rm(join(from, 'plugins/security-scan/src/index.ts'))
  await put(from, 'plugins/security-scan/src/main.ts', 'export {}\n')
  const result = await exportSecurityScan({ source: from, dest, log: () => {} })
  assert.deepEqual(result.removed, ['src/index.ts'])
  await assert.rejects(readFile(join(dest, 'src/index.ts')), { code: 'ENOENT' })
  assert.equal(await readFile(join(dest, 'NOTES.md'), 'utf8'), 'maintainer notes\n')
  assert.equal(await readFile(join(dest, '.git/HEAD'), 'utf8'), 'ref: refs/heads/main\n')
  assert.ok(JSON.parse(await readFile(join(dest, MANIFEST_NAME), 'utf8')).files.includes('src/main.ts'))
})

test('refuses private identifiers, an unbuilt plugin and destinations inside the source', async t => {
  const dest = join(await scratch(t), 'public')
  await assert.rejects(exportSecurityScan({ source: await source(t, { readme: 'see https://example.woa.com/x\n' }), dest, log: () => {} }), /Private identifier/u)
  await assert.rejects(exportSecurityScan({ source: await source(t, { withLib: false }), dest, log: () => {} }), /Build the plugin/u)
  const from = await source(t)
  await assert.rejects(exportSecurityScan({ source: from, dest: join(from, 'out'), log: () => {} }), /outside the source/u)
  assert.throws(() => assertPublicText('a.md', 'AIDEV notes'), /Private identifier/u)
  assert.throws(() => parseArgs([]), /Usage/u)
  assert.deepEqual(parseArgs(['--dest', '/tmp/x', '--refresh-lock']), { dest: '/tmp/x', refreshLock: true })
})

test('the real plugin source exports without private identifiers', async t => {
  const dest = join(await scratch(t), 'public')
  const result = await exportSecurityScan({ source: sourceRoot, dest, log: () => {} }).catch(error => {
    if (/Build the plugin/u.test(error.message)) return t.skip('plugin lib is not built')
    throw error
  })
  if (!result) return
  const manifest = JSON.parse(await readFile(join(dest, 'package.json'), 'utf8'))
  assert.equal(manifest.name, '@shamcleren/dsh-security-scan')
  assert.equal(manifest.repository.url, 'git+https://github.com/shamcleren/dsh-security-scan.git')
  assert.ok(manifest.keywords.includes('dsh-plugin'))
  assert.ok(result.files.includes('pnpm-lock.yaml') && result.files.includes('.github/workflows/ci.yml'))
  assert.ok(!result.files.some(file => file.startsWith('standalone/')))
  assert.ok(!result.files.some(file => file.startsWith('evaluation/') || /^(?:src|lib)\/evaluation\./u.test(file)))
})
