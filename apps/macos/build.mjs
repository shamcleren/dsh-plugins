/** Build the native shell around a locked official npm runtime. */
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { cp, mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, resolve, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildOptions, dshHomePlistEntry } from './build-options.mjs'
import { buildAppOutput } from './build-output.mjs'
import { shareBuildOptions, buildShareExtension } from './share-build.mjs'

const root = dirname(fileURLToPath(import.meta.url))
const args = process.argv.slice(2)
const flags = new Map()
for (let index = 0; index < args.length; index += 2) {
  const key = args[index], value = args[index + 1]
  if (!['--install-root', '--runtime-root', '--output-dir'].includes(key) || !value || value.startsWith('--') || flags.has(key)) throw new Error('Usage: node build.mjs [--install-root <directory>] [--runtime-root <staged-runtime> --output-dir <staging-directory>]')
  flags.set(key, resolve(value))
}
const installationRoot = flags.get('--install-root')
const runtimeRoot = flags.get('--runtime-root') ?? (installationRoot === undefined ? undefined : join(installationRoot, 'runtime'))
const outputDirectory = flags.get('--output-dir')
if ((flags.has('--runtime-root') || outputDirectory) && !installationRoot) throw new Error('Staged builds require an installation root')
const options = buildOptions(installationRoot)
const shareOptions = shareBuildOptions(options.bundleIdentifier)
let dshHome
if (installationRoot !== undefined) {
  const state = JSON.parse(await readFile(join(installationRoot, 'bootstrap-state.json'), 'utf8'))
  if (state.owner !== 'shamcleren/dsh-plugin/bootstrap-v1' || ![1, 2].includes(state.schemaVersion)) throw new Error('Invalid installation state')
  dshHome = state.schemaVersion === 1 ? join(installationRoot, 'home') : state.dshHome
  if (typeof dshHome !== 'string' || !isAbsolute(dshHome)) throw new Error('Invalid DSH configuration directory')
}
const appName = 'DeepSeek Harness'
async function run(command, args, cwd = root) {
  await new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, stdio: 'inherit' })
    child.once('error', reject)
    child.once('close', (code, signal) => code === 0 ? resolve() : reject(new Error(command + ' failed: ' + (signal ?? code))))
  })
}
const architecture = process.arch
if (process.platform !== 'darwin' || !['arm64', 'x64'].includes(architecture)) throw new Error('Build requires macOS arm64 or x64')
const pins = (await readFile(join(root, '../../runtime/node-release.sha256'), 'utf8')).trim().split('\n')
const entries = pins.filter(line => line.endsWith('-darwin-' + architecture + '.tar.gz'))
if (entries.length !== 1) throw new Error('Missing or ambiguous pinned Node.js release')
const pin = entries[0].match(/^([a-f0-9]{64})\s+node-v(\d+\.\d+\.\d+)-darwin-(?:arm64|x64)\.tar\.gz$/)
if (!pin) throw new Error('Invalid pinned Node.js release')
const [, nodeHash, nodeVersion] = pin
const dist = outputDirectory ?? (installationRoot === undefined ? join(root, 'dist') : installationRoot)
const version = JSON.parse(await readFile(join(root, 'package.json'), 'utf8')).version
const output = await buildAppOutput(dist, async app => {
  const contents = join(app, 'Contents')
  const resources = join(contents, 'Resources')
  await mkdir(join(contents, 'MacOS'), { recursive: true })
  await mkdir(resources, { recursive: true })

  // Frozen public package installation provides the runtime without a DSH checkout.
  const runtime = join(resources, 'runtime')
  await mkdir(runtime, { recursive: true })
  for (const name of ['package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml']) {
    await cp(join(root, '../../runtime', name), join(runtime, name))
  }
  if (installationRoot === undefined) await run('pnpm', ['install', '--frozen-lockfile', '--ignore-scripts', '--prod'], runtime)
  else await cp(join(runtimeRoot, 'node_modules'), join(runtime, 'node_modules'), { recursive: true, verbatimSymlinks: true })
  const archiveName = 'node-v' + nodeVersion + '-darwin-' + architecture
  const cache = installationRoot === undefined ? join(root, '.cache') : join(installationRoot, 'cache/node')
  await mkdir(cache, { recursive: true })
  const archive = join(cache, archiveName + '.tar.gz')
  let bytes
  try { bytes = await readFile(archive) } catch (error) { if (error.code !== 'ENOENT') throw error }
  if (bytes === undefined || createHash('sha256').update(bytes).digest('hex') !== nodeHash) {
    await run('curl', ['-fL', 'https://nodejs.org/dist/v' + nodeVersion + '/' + archiveName + '.tar.gz', '-o', archive])
    bytes = await readFile(archive)
  }
  if (createHash('sha256').update(bytes).digest('hex') !== nodeHash) throw new Error('Node archive digest mismatch')
  await mkdir(join(resources, 'node'), { recursive: true })
  await run('/usr/bin/tar', ['-xzf', archive, '-C', join(resources, 'node'), '--strip-components=1', archiveName + '/bin/node', archiveName + '/LICENSE'])

  let plist = (await readFile(join(root, 'Resources/Info.plist'), 'utf8'))
    .replaceAll('__APP_NAME__', appName).replace('__APP_VERSION__', version)
    .replace('__BUNDLE_IDENTIFIER__', options.bundleIdentifier)
    .replace('__SERVICE_PORT__', String(options.servicePort))
    .replace('__DSH_HOME_ENTRY__', dshHomePlistEntry(dshHome))
  if (installationRoot !== undefined) {
    const xml = installationRoot.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&apos;')
    plist = plist.replace('</plist>', '').replace(/<\/dict>\s*$/, '<key>DSHInstallationRoot</key><string>' + xml + '</string>\n</dict>\n</plist>\n')
  }
  if (shareOptions) plist = plist.replace('</plist>', '').replace(/<\/dict>\s*$/, '<key>DSHShareGroup</key><string>' + shareOptions.group + '</string>\n</dict>\n</plist>\n')
  await writeFile(join(contents, 'Info.plist'), plist)
  await cp(join(root, 'Resources/AppIcon.icns'), join(resources, 'AppIcon.icns'))
  await cp(join(root, 'LICENSE'), join(resources, 'LICENSE'))
  await cp(join(root, 'launcher'), join(resources, 'launcher'), { recursive: true })
  const sources = (await readdir(join(root, 'Sources'))).filter(name => name.endsWith('.swift')).sort()
  const target = (architecture === 'x64' ? 'x86_64' : architecture) + '-apple-macosx13.5'
  await run('/usr/bin/xcrun', ['swiftc', '-target', target,
    '-O', '-framework', 'AppKit', '-framework', 'WebKit', ...sources.map(name => join(root, 'Sources', name)), join(root, 'Share/ShareInbox.swift'), '-o', join(contents, 'MacOS/DeepSeekHarness')])
  await run('/usr/bin/xcrun', ['swiftc', '-target', target, '-O',
    join(root, 'Sources/HostRestartRequest.swift'), join(root, 'Control/main.swift'),
    '-o', join(contents, 'MacOS/DeepSeekHarnessControl')])
  await run(join(resources, 'node/bin/node'), [join(runtime, 'node_modules/@deepseek-ai/dsh/lib/bin.js'), '--version'], runtime)
  // Sign nested code first. A final --deep signing pass would replace the extension's sandbox entitlements.
  if (shareOptions) await run('/usr/bin/codesign', ['--deep', '--force', '--sign', shareOptions.identity, '--timestamp=none', app])
  const appEntitlements = shareOptions ? await buildShareExtension({ root, contents, bundleIdentifier: options.bundleIdentifier, version, target, options: shareOptions, run }) : undefined
  if (shareOptions) await run('/usr/bin/codesign', ['--force', '--sign', shareOptions.identity, '--timestamp=none', join(resources, 'node/bin/node')])
  await run('/usr/bin/codesign', [...(shareOptions ? [] : ['--deep']), '--force', '--sign', process.env.CODESIGN_IDENTITY ?? '-', '--timestamp=none', ...(appEntitlements ? ['--entitlements', appEntitlements] : []), app])
  await run('/usr/bin/codesign', ['--verify', '--deep', '--strict', app])
  await run('/usr/bin/plutil', ['-lint', join(contents, 'Info.plist')])
})
if (installationRoot !== undefined) await writeFile(join(outputDirectory ?? installationRoot, 'native-app.json'), JSON.stringify({ app: relative(outputDirectory ?? installationRoot, output), version, servicePort: options.servicePort, ...(shareOptions ? { shareSigning: { team: shareOptions.team, identity: shareOptions.identity } } : {}) }) + '\n', { mode: 0o600 })
console.log('Built ' + output)
