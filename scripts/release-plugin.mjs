/** Build and pack a new immutable catalog release; does not publish or update any installation. */
import { createHash } from 'node:crypto'
import { cp, lstat, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { run } from './process.mjs'
import { pluginSourceDigest } from './release-inputs.mjs'
import { releaseArtifact } from './plugins.mjs'

export async function releasePlugin(id, repo = fileURLToPath(new URL('..', import.meta.url))) {
  const catalogPath = join(repo, 'marketplace.json'), catalog = JSON.parse(await readFile(catalogPath, 'utf8'))
  const entry = catalog.plugins.find(p => p.id === id || p.package === id || (id === 'marketplace' && p.id === 'trusted-marketplace'))
  if (!entry) throw new Error('Unknown catalog plugin')
  let directory
  for (const name of await readdir(join(repo, 'plugins'))) {
    const candidate = join(repo, 'plugins', name)
    if (JSON.parse(await readFile(join(candidate, 'package.json'), 'utf8')).name === entry.package) directory = candidate
  }
  if (!directory) throw new Error('Plugin source is missing')
  const manifest = JSON.parse(await readFile(join(directory, 'package.json'), 'utf8'))
  if (manifest.version === entry.version) throw new Error('Increment the component version before preparing a new release')
  const filename = manifest.name.replace(/^@/, '').replaceAll('/', '-') + '-' + manifest.version + '.tgz'
  const output = join(repo, 'artifacts', filename)
  try { await lstat(output); throw new Error('Release already exists; increment the component version before packing') }
  catch (error) { if (error.code !== 'ENOENT') throw error }
  const sourceDigest = await pluginSourceDigest(directory, repo)
  // Only generated build output belonging to this component is cleaned.
  await rm(join(directory, 'lib'), { recursive: true, force: true })
  await run('pnpm', ['--dir', directory, 'build'], { cwd: repo })
  if (sourceDigest !== await pluginSourceDigest(directory, repo)) throw new Error('Release inputs changed while building')
  const scratch = await mkdtemp(join(tmpdir(), 'dhp-release-'))
  let artifactWritten = false, catalogWritten = false
  try {
    const stage = join(scratch, 'package')
    await cp(directory, stage, { recursive: true, filter: source => !source.split('/').some(name => ['node_modules', '.cache', 'coverage'].includes(name)) })
    await writeFile(join(stage, 'package.json'), JSON.stringify({ ...manifest, dshPluginRelease: { schemaVersion: 1, sourceDigest } }, null, 2) + '\n')
    await run('npm', ['pack', '--ignore-scripts', '--pack-destination', scratch], {
      cwd: stage, env: { ...process.env, npm_config_cache: join(scratch, 'npm-cache') },
    })
    const bytes = await readFile(join(scratch, filename))
    const next = { ...entry, version: manifest.version, sourceDigest, artifact: { ...entry.artifact, path: 'artifacts/' + filename, size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') } }
    await writeFile(output, bytes, { flag: 'wx' }); artifactWritten = true
    await releaseArtifact(repo, next)
    catalog.plugins[catalog.plugins.indexOf(entry)] = next
    await writeFile(catalogPath, JSON.stringify(catalog, null, 2) + '\n'); catalogWritten = true
    // The superseded path is explicitly owned by the old catalog entry.
    if (entry.artifact.path !== next.artifact.path && /^artifacts\/[^/]+\.tgz$/.test(entry.artifact.path)) await rm(join(repo, entry.artifact.path))
    return next
  } finally {
    await rm(scratch, { recursive: true, force: true })
    if (artifactWritten && !catalogWritten) await rm(output)
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    if (process.argv.length !== 3) throw new Error('Usage: node scripts/release-plugin.mjs <catalog-id>')
    const entry = await releasePlugin(process.argv[2])
    console.log('Prepared ' + entry.id + '@' + entry.version + ' (' + entry.artifact.sha256 + ')')
  } catch (error) { console.error(error.message); process.exitCode = 1 }
}
