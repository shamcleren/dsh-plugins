/** Plan or execute uploading local catalog tarballs to a GitHub Release and switching marketplace.json to URL distribution. */
import { readFile, rm, writeFile } from 'node:fs/promises'
import { basename, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { run } from './process.mjs'
import { parseTrustedReleaseUrl, resolveReleaseArtifact } from './release-artifact.mjs'

const DEFAULT_REPO = 'shamcleren/dsh-plugins'

/**
 * @param {string[]} args
 */
export function parsePublishArgs(args) {
  let tag
  let githubRepo = DEFAULT_REPO
  let execute = false
  let updateCatalog = false
  let removeLocal = false
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (arg === '--tag') tag = args[++i]
    else if (arg.startsWith('--tag=')) tag = arg.slice('--tag='.length)
    else if (arg === '--repo') githubRepo = args[++i]
    else if (arg.startsWith('--repo=')) githubRepo = arg.slice('--repo='.length)
    else if (arg === '--execute') execute = true
    else if (arg === '--update-catalog') updateCatalog = true
    else if (arg === '--remove-local') removeLocal = true
    else throw new Error('Unknown option: ' + arg)
  }
  if (!tag || !/^[A-Za-z0-9._-]+$/.test(tag)) throw new Error('--tag <release-tag> is required')
  if (!githubRepo || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(githubRepo)) throw new Error('Invalid --repo <owner>/<repo>')
  if (removeLocal && !updateCatalog) throw new Error('--remove-local requires --update-catalog')
  return { tag, githubRepo, execute, updateCatalog, removeLocal }
}

/**
 * Validate all local catalog tarballs and build the GitHub Release upload plan.
 * @param {{ repo?: string, tag: string, githubRepo?: string, execute?: boolean, updateCatalog?: boolean, removeLocal?: boolean, runner?: typeof run, log?: (line: string) => void }} options
 */
export async function publishGithubRelease({
  repo = fileURLToPath(new URL('..', import.meta.url)),
  tag,
  githubRepo = DEFAULT_REPO,
  execute = false,
  updateCatalog = false,
  removeLocal = false,
  runner = run,
  log = console.log,
}) {
  const catalogPath = join(repo, 'marketplace.json')
  const catalog = JSON.parse(await readFile(catalogPath, 'utf8'))
  if (catalog.schemaVersion !== 1 || !Array.isArray(catalog.plugins)) throw new Error('Invalid marketplace.json')

  /** @type {{ id: string, version: string, localPath: string, relativePath: string, url: string, sha256: string, size: number }[]} */
  const assets = []
  for (const entry of catalog.plugins) {
    if (!entry.artifact?.path) continue
    await resolveReleaseArtifact(repo, entry)
    const filename = basename(entry.artifact.path)
    const url = `https://github.com/${githubRepo}/releases/download/${tag}/${filename}`
    parseTrustedReleaseUrl(url, githubRepo)
    assets.push({
      id: entry.id,
      version: entry.version,
      localPath: join(repo, entry.artifact.path),
      relativePath: entry.artifact.path,
      url,
      sha256: entry.artifact.sha256,
      size: entry.artifact.size,
    })
  }

  const ghArgs = ['release', 'create', tag, '--repo', githubRepo, '--title', tag, '--notes', `Verified plugin tarballs for ${tag}`, ...assets.map(item => item.localPath)]
  if (!execute) {
    log(`Dry run (${assets.length} verified assets for ${githubRepo}@${tag}):`)
    for (const asset of assets) {
      log(`  ${asset.id}@${asset.version} -> ${asset.url} (${asset.size} bytes, sha256=${asset.sha256.slice(0, 12)}…)`)
    }
    log('Run with --execute to upload via gh CLI, and --update-catalog [--remove-local] once uploaded.')
  } else if (assets.length > 0) {
    await runner('gh', ghArgs, { cwd: repo })
  }

  if (updateCatalog) {
    const byId = new Map(assets.map(item => [item.id, item]))
    for (const entry of catalog.plugins) {
      const asset = byId.get(entry.id)
      if (!asset) continue
      const nextArtifact = {
        ...(removeLocal ? {} : { path: entry.artifact.path }),
        url: asset.url,
        sha256: entry.artifact.sha256,
        size: entry.artifact.size,
      }
      entry.artifact = nextArtifact
    }
    await writeFile(catalogPath, JSON.stringify(catalog, null, 2) + '\n')
    if (removeLocal) {
      for (const asset of assets) await rm(asset.localPath, { force: true })
    }
  }

  return { tag, githubRepo, assets, ghArgs }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const options = parsePublishArgs(process.argv.slice(2))
    await publishGithubRelease(options)
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  }
}
