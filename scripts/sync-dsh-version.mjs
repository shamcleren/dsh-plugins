/** Audit or synchronize pinned @deepseek-ai/dsh* versions across runtime, plugins, workspace, and catalog. */
import { readFile, readdir, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const EXACT_VERSION = /^\d+\.\d+\.\d+(?:-[\w.]+)?$/
const DSH_PACKAGE = /^@deepseek-ai\/dsh(?:-[a-z0-9-]+)?$/
const WORKSPACE_PIN_LINE = /^(\s*-\s*['"]?)(@deepseek-ai\/dsh(?:-[a-z0-9-]+)?)@([^'"\s]+)(['"]?\s*)$/

/**
 * @param {string[]} args
 */
export function parseSyncArgs(args) {
  let check = false
  let to
  let write = false
  let includeCatalog = false
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (arg === '--check') check = true
    else if (arg === '--write') write = true
    else if (arg === '--include-catalog') includeCatalog = true
    else if (arg === '--to') to = args[++i]
    else if (arg.startsWith('--to=')) to = arg.slice('--to='.length)
    else throw new Error('Unknown option: ' + arg)
  }
  if (to !== undefined && !EXACT_VERSION.test(to)) {
    throw new Error('Target DSH version must be an exact release version: ' + to)
  }
  if (!to) check = true
  if (check && write) throw new Error('--write cannot be combined with --check')
  if (includeCatalog && !to) throw new Error('--include-catalog requires --to <version>')
  return { check, to, write, includeCatalog }
}

/**
 * Scan all pinned @deepseek-ai/dsh* declarations in the repository.
 * @param {string} repo
 * @param {{ targetVersion?: string, includeCatalog?: boolean, write?: boolean }} [options]
 */
export async function syncDshVersion(repo = fileURLToPath(new URL('..', import.meta.url)), options = {}) {
  const runtimePath = join(repo, 'runtime/package.json')
  const runtimeManifest = JSON.parse(await readFile(runtimePath, 'utf8'))
  const currentVersion = runtimeManifest.dependencies?.['@deepseek-ai/dsh']
  if (typeof currentVersion !== 'string' || !EXACT_VERSION.test(currentVersion)) {
    throw new Error('runtime/package.json must pin an exact @deepseek-ai/dsh version')
  }

  const target = options.targetVersion ?? currentVersion
  const write = options.write === true
  const includeCatalog = options.includeCatalog === true

  /** @type {{ file: string, field: string, current: string, expected: string }[]} */
  const mismatches = []
  /** @type {string[]} */
  const updatedFiles = []
  let checkedPins = 0

  checkedPins++
  if (currentVersion !== target) {
    mismatches.push({ file: 'runtime/package.json', field: 'dependencies.@deepseek-ai/dsh', current: currentVersion, expected: target })
    if (write) {
      runtimeManifest.dependencies['@deepseek-ai/dsh'] = target
      await writeFile(runtimePath, JSON.stringify(runtimeManifest, null, 2) + '\n')
      updatedFiles.push('runtime/package.json')
    }
  }

  const pluginsDir = join(repo, 'plugins')
  const pluginEntries = (await readdir(pluginsDir, { withFileTypes: true }))
    .filter(entry => entry.isDirectory())
    .sort((a, b) => a.name.localeCompare(b.name))

  for (const folder of pluginEntries) {
    const relativePath = `plugins/${folder.name}/package.json`
    const manifestPath = join(repo, relativePath)
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
    let dirty = false

    if (manifest.engines?.dsh !== undefined) {
      checkedPins++
      if (manifest.engines.dsh !== target) {
        mismatches.push({ file: relativePath, field: 'engines.dsh', current: String(manifest.engines.dsh), expected: target })
        manifest.engines.dsh = target
        dirty = true
      }
    }

    for (const section of ['dependencies', 'peerDependencies', 'devDependencies']) {
      const deps = manifest[section]
      if (!deps || typeof deps !== 'object') continue
      for (const [pkg, version] of Object.entries(deps)) {
        if (!DSH_PACKAGE.test(pkg)) continue
        checkedPins++
        if (version !== target) {
          mismatches.push({ file: relativePath, field: `${section}.${pkg}`, current: String(version), expected: target })
          deps[pkg] = target
          dirty = true
        }
      }
    }

    if (dirty && write) {
      await writeFile(manifestPath, JSON.stringify(manifest, null, 2) + '\n')
      updatedFiles.push(relativePath)
    }
  }

  for (const relativeWorkspace of ['pnpm-workspace.yaml', 'runtime/pnpm-workspace.yaml']) {
    let content
    try { content = await readFile(join(repo, relativeWorkspace), 'utf8') }
    catch (error) {
      if (/** @type {NodeJS.ErrnoException} */ (error).code === 'ENOENT') continue
      throw error
    }
    const lines = content.split('\n')
    let dirty = false
    const nextLines = lines.map((line, index) => {
      const match = WORKSPACE_PIN_LINE.exec(line)
      if (!match) return line
      const [, prefix, pkg, version, suffix] = match
      checkedPins++
      if (version !== target) {
        mismatches.push({ file: relativeWorkspace, field: `line ${index + 1} (${pkg})`, current: version, expected: target })
        dirty = true
        return `${prefix}${pkg}@${target}${suffix}`
      }
      return line
    })
    if (dirty && write) {
      await writeFile(join(repo, relativeWorkspace), nextLines.join('\n'))
      updatedFiles.push(relativeWorkspace)
    }
  }

  const catalogPath = join(repo, 'marketplace.json')
  const catalog = JSON.parse(await readFile(catalogPath, 'utf8'))
  let catalogDirty = false
  if (Array.isArray(catalog.plugins)) {
    for (const entry of catalog.plugins) {
      checkedPins++
      if (entry.dshVersion !== target) {
        if (!options.targetVersion || includeCatalog) {
          mismatches.push({ file: 'marketplace.json', field: `plugins[${entry.id}].dshVersion`, current: String(entry.dshVersion), expected: target })
        }
        if (includeCatalog && write) {
          entry.dshVersion = target
          catalogDirty = true
        }
      }
    }
  }
  if (catalogDirty && write) {
    await writeFile(catalogPath, JSON.stringify(catalog, null, 2) + '\n')
    updatedFiles.push('marketplace.json')
  }

  return { currentVersion, targetVersion: target, checkedPins, mismatches, updatedFiles }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const args = parseSyncArgs(process.argv.slice(2))
    const result = await syncDshVersion(undefined, {
      ...(args.to === undefined ? {} : { targetVersion: args.to }),
      write: args.write,
      includeCatalog: args.includeCatalog,
    })
    if (args.check) {
      if (result.mismatches.length > 0) {
        console.error(`Found ${result.mismatches.length} DSH version mismatch(es) against ${result.targetVersion}:`)
        for (const item of result.mismatches.slice(0, 30)) {
          console.error(`  ${item.file} -> ${item.field}: ${item.current} (expected ${item.expected})`)
        }
        if (result.mismatches.length > 30) console.error(`  ...and ${result.mismatches.length - 30} more`)
        process.exitCode = 1
      } else {
        console.log(`All ${result.checkedPins} DSH version pins match ${result.targetVersion}.`)
      }
    } else if (!args.write) {
      console.log(`Dry run: ${result.mismatches.length} pin(s) out of ${result.checkedPins} would change from ${result.currentVersion} to ${result.targetVersion}.`)
      console.log('Re-run with --write to update manifests, then refresh pnpm-lock.yaml and runtime/pnpm-lock.yaml.')
    } else {
      console.log(`Updated ${result.updatedFiles.length} file(s) (${result.mismatches.length} pins) to ${result.targetVersion}:`)
      for (const file of result.updatedFiles) console.log('  ' + file)
      console.log('Next: refresh pnpm-lock.yaml and runtime/pnpm-lock.yaml, run pnpm typecheck && pnpm test, and repack plugins.')
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  }
}
