/** Export plugins/security-scan as a standalone, buildable public repository checkout. */
import { spawnSync } from 'node:child_process'
import { copyFile, lstat, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

export const sourceRoot = dirname(dirname(fileURLToPath(import.meta.url)))
export const PLUGIN_DIR = 'plugins/security-scan'
export const MANIFEST_NAME = '.standalone-export-manifest.json'
// Exported text must not identify internal hosts, private components or local machines.
const FORBIDDEN = [/(?:[\w-]+\.)+woa\.com\b/iu, /\baidev\b/iu, /\/Users\//u]
const BINARY = /\.(?:tgz|png|jpe?g|gif|webp|woff2?|zip|gz|ico|icns)$/iu
const REQUIRED_LIB = ['lib/index.js', 'lib/index.d.ts', 'lib/cli.js', 'lib/client.js']
// Repository-level files owned by the standalone checkout; the plugin package itself never ships them.
const TEMPLATES = [
  ['standalone/gitignore', '.gitignore'],
  ['standalone/ci.yml', '.github/workflows/ci.yml'],
  ['standalone/pnpm-lock.yaml', 'pnpm-lock.yaml'],
]

export function parseArgs(argv) {
  const options = { dest: undefined, refreshLock: false }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--dest') {
      options.dest = argv[++i]
      if (!options.dest || options.dest.startsWith('--')) throw new Error('--dest requires a value')
    } else if (arg === '--refresh-lock') options.refreshLock = true
    else throw new Error('Unknown argument: ' + arg)
  }
  if (!options.dest) throw new Error('Usage: node scripts/export-security-scan.mjs --dest /path/to/dsh-security-scan [--refresh-lock]')
  return options
}

const posix = value => value.split(sep).join('/')

function gitFiles(root, directory) {
  const listed = spawnSync('git', ['-C', root, 'ls-files', '-z', '--cached', '--others', '--exclude-standard', '--', directory], { encoding: 'buffer' })
  if (listed.status !== 0) throw new Error(String(listed.stderr || 'git ls-files failed'))
  return listed.stdout.toString('utf8').split('\0').filter(Boolean).map(posix)
}

async function regularFile(path) {
  try {
    const info = await lstat(path)
    return info.isFile() && !info.isSymbolicLink()
  } catch (error) {
    if (error.code === 'ENOENT') return false
    throw error
  }
}

async function walk(root, prefix) {
  const files = []
  for (const entry of await readdir(join(root, prefix), { withFileTypes: true })) {
    const rel = prefix + '/' + entry.name
    if (entry.isSymbolicLink()) throw new Error('Refusing to export symbolic link ' + rel)
    if (entry.isDirectory()) files.push(...await walk(root, rel))
    else if (entry.isFile()) files.push(rel)
  }
  return files
}

export function assertPublicText(rel, text) {
  for (const pattern of FORBIDDEN) if (pattern.test(text)) throw new Error('Private identifier ' + pattern + ' remains in ' + rel)
}

/** Map destination paths to their source bytes. */
export async function collectFiles(source = sourceRoot, { allowMissingLock = false } = {}) {
  const plugin = join(source, PLUGIN_DIR)
  const files = new Map()
  for (const name of gitFiles(source, PLUGIN_DIR)) {
    const rel = posix(relative(PLUGIN_DIR, name))
    if (rel.startsWith('standalone/') || rel.startsWith('node_modules/') || rel.startsWith('lib/')) continue
    if (await regularFile(join(source, name))) files.set(rel, await readFile(join(source, name)))
  }
  // Git installs consume lib/ directly, so the export carries the current release build.
  for (const required of REQUIRED_LIB) if (!await regularFile(join(plugin, required))) throw new Error('Build the plugin before exporting; missing ' + required)
  for (const rel of await walk(plugin, 'lib')) files.set(rel, await readFile(join(plugin, rel)))
  for (const [from, to] of TEMPLATES) {
    if (!await regularFile(join(plugin, from))) {
      // The first --refresh-lock run creates the lockfile from the exported manifest.
      if (allowMissingLock && to === 'pnpm-lock.yaml') continue
      throw new Error('Missing standalone template ' + from)
    }
    files.set(to, await readFile(join(plugin, from)))
  }
  const config = JSON.parse(files.get('tsconfig.json')?.toString('utf8') ?? 'null')
  if (config?.extends !== '../../tsconfig.base.json') throw new Error('Unexpected tsconfig.json base')
  config.extends = './tsconfig.base.json'
  files.set('tsconfig.json', Buffer.from(JSON.stringify(config, null, 2) + '\n'))
  files.set('tsconfig.base.json', await readFile(join(source, 'tsconfig.base.json')))
  for (const [rel, bytes] of files) if (!BINARY.test(rel) && !bytes.includes(0)) assertPublicText(rel, bytes.toString('utf8'))
  return files
}

async function previousFiles(dest) {
  try {
    const manifest = JSON.parse(await readFile(join(dest, MANIFEST_NAME), 'utf8'))
    return Array.isArray(manifest.files) ? manifest.files.filter(file => typeof file === 'string') : []
  } catch (error) {
    if (error.code === 'ENOENT') return []
    throw error
  }
}

function safeRelative(rel) {
  const path = posix(rel)
  if (!path || path.startsWith('/') || path.split('/').some(part => part === '..' || part === '.' || part === '') || path === '.git' || path.startsWith('.git/')) {
    throw new Error('Refusing unsafe export path ' + rel)
  }
  return path
}

export async function exportSecurityScan({ dest, refreshLock = false, source = sourceRoot, log = console.log } = {}) {
  const from = resolve(source)
  const to = resolve(dest)
  if (to === from || to.startsWith(from + sep) || from.startsWith(to + sep)) throw new Error('Destination must be outside the source repository')
  const files = await collectFiles(from, { allowMissingLock: refreshLock })
  const names = [...files.keys()].map(safeRelative).sort()
  // Only files recorded by an earlier export are removed; .git and unknown files stay untouched.
  const stale = (await previousFiles(to)).map(safeRelative).filter(file => !files.has(file))
  await mkdir(to, { recursive: true })
  for (const rel of stale) await rm(join(to, rel), { force: true })
  for (const rel of names) {
    await mkdir(join(to, dirname(rel)), { recursive: true })
    await writeFile(join(to, rel), files.get(rel))
  }
  await writeFile(join(to, MANIFEST_NAME), JSON.stringify({ files: names }, null, 2) + '\n')
  if (refreshLock) {
    const install = spawnSync('pnpm', ['install', '--lockfile-only', '--ignore-scripts'], { cwd: to, stdio: 'inherit' })
    if (install.status !== 0) throw new Error('pnpm could not refresh the standalone lockfile')
    await copyFile(join(to, 'pnpm-lock.yaml'), join(from, PLUGIN_DIR, 'standalone/pnpm-lock.yaml'))
    if (!names.includes('pnpm-lock.yaml')) names.push('pnpm-lock.yaml')
    names.sort()
    await writeFile(join(to, MANIFEST_NAME), JSON.stringify({ files: names }, null, 2) + '\n')
  }
  log('exported ' + names.length + ' files to ' + to + (stale.length ? '; removed ' + stale.length + ' stale files' : ''))
  return { dest: to, files: names, removed: stale }
}

const invoked = process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])
if (invoked) await exportSecurityScan(parseArgs(process.argv.slice(2)))
