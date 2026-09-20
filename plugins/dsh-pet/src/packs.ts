/**
 * Pet pack scanning, validation, and idempotent copy from the source directory
 * into `DSH_HOME/desktop-pet/packs/`.
 */

import { cp, mkdir, readFile, readdir, rm, stat } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { expandHomePath } from '@deepseek-ai/dsh-home-paths'
import { atlasForDimensions } from './shared/atlas.js'
import { parsePetManifest, type PetManifest } from './shared/manifest.js'

export interface PetPack {
  id: string
  displayName: string
  description?: string
  spriteVersionNumber?: 1 | 2
  spritesheetPath: string
  /** Absolute directory containing pet.json and its spritesheet. */
  directory: string
  /** Pixel width of the spritesheet, read from its WebP header. */
  spriteWidth: number
  /** Pixel height of the spritesheet, read from its WebP header. */
  spriteHeight: number
}

export interface ScanResult {
  packs: PetPack[]
  errors: string[]
}

export interface SyncPacksOptions {
  /** Report an unreadable source as an error. Optional import sources disable this. */
  missingSourceIsError?: boolean
  /** Ignore retired or package-reserved ids while importing an external source. */
  excludedIds?: readonly string[]
}

function isReadableDir(stats: Awaited<ReturnType<typeof stat>>): boolean {
  return stats.isDirectory()
}

/**
 * Validate that a spritesheet file declares one of the known atlas pixel sizes
 * and return its pixel dimensions.
 */
async function assertAtlasMatches(spritesheetFile: string, spriteVersionNumber: number | undefined): Promise<{ width: number; height: number }> {
  const bytes = await readFile(spritesheetFile)
  const dims = decodeWebPDimensions(bytes)
  const atlas = dims === null ? null : atlasForDimensions(dims.width, dims.height)
  if (atlas === null) {
    throw new Error(
      `spritesheet ${basename(spritesheetFile)} has unsupported dimensions ` +
      (dims === null ? '(unreadable)' : `${dims.width}×${dims.height}`),
    )
  }
  const expectedVersion = spriteVersionNumber ?? 1
  if (atlas.version !== expectedVersion) {
    throw new Error(
      `spritesheet ${basename(spritesheetFile)} atlas v${atlas.version} does not match manifest v${expectedVersion}`,
    )
  }
  return { width: atlas.width, height: atlas.height }
}

/** Minimal lossless/lossy WebP (VP8/VP8L/VP8X) dimension reader. */
function decodeWebPDimensions(bytes: Buffer): { width: number; height: number } | null {
  if (bytes.length < 30 || bytes.toString('ascii', 0, 4) !== 'RIFF' || bytes.toString('ascii', 8, 12) !== 'WEBP') {
    return null
  }
  const chunk = bytes.toString('ascii', 12, 16)
  if (chunk === 'VP8 ' && bytes.length >= 30) {
    // Lossy: 14-bit width/height in the frame header.
    const w = bytes.readUInt16LE(26) & 0x3fff
    const h = bytes.readUInt16LE(28) & 0x3fff
    return { width: w, height: h }
  }
  if (chunk === 'VP8L' && bytes.length >= 25) {
    // Lossless: packed 14-bit fields.
    const bits = bytes.readUInt32LE(21)
    const w = (bits & 0x3fff) + 1
    const h = ((bits >>> 14) & 0x3fff) + 1
    return { width: w, height: h }
  }
  if (chunk === 'VP8X' && bytes.length >= 30) {
    const w = 1 + bytes.readUIntLE(24, 3)
    const h = 1 + bytes.readUIntLE(27, 3)
    return { width: w, height: h }
  }
  return null
}

/** Load and validate a single pack directory, returning null when invalid. */
async function loadPack(directory: string): Promise<PetPack | null> {
  try {
    const manifestFile = join(directory, 'pet.json')
    const manifest = parsePetManifest(await readFile(manifestFile, 'utf8'))
    const spritesheetFile = join(directory, manifest.spritesheetPath)
    const dims = await assertAtlasMatches(spritesheetFile, manifest.spriteVersionNumber)
    return {
      id: manifest.id,
      displayName: manifest.displayName,
      ...(manifest.description !== undefined ? { description: manifest.description } : {}),
      ...(manifest.spriteVersionNumber !== undefined ? { spriteVersionNumber: manifest.spriteVersionNumber } : {}),
      spritesheetPath: manifest.spritesheetPath,
      directory,
      spriteWidth: dims.width,
      spriteHeight: dims.height,
    }
  } catch {
    return null
  }
}

/**
 * Copy each valid source pack into `targetDir/<id>/` idempotently. Returns the
 * list of packs now present in the target directory, plus per-pack errors.
 */
export async function syncPacks(
  sourceDir: string,
  targetDir: string,
  options: SyncPacksOptions = {},
): Promise<ScanResult> {
  const source = expandHomePath(sourceDir)
  await mkdir(targetDir, { recursive: true })
  const errors: string[] = []

  let entries: string[] = []
  try {
    entries = await readdir(source)
  } catch {
    if (options.missingSourceIsError !== false) {
      errors.push(`source directory not readable: ${source}`)
    }
    return { packs: await scanTarget(targetDir), errors }
  }

  for (const entry of entries) {
    const packDir = join(source, entry)
    let packStats
    try {
      packStats = await stat(packDir)
    } catch {
      continue
    }
    if (!isReadableDir(packStats)) continue

    const pack = await loadPack(packDir)
    if (pack === null) {
      errors.push(`skipping invalid pack: ${entry}`)
      continue
    }
    if (options.excludedIds?.includes(pack.id)) continue
    const destination = join(targetDir, pack.id)
    try {
      await cp(packDir, destination, { recursive: true, force: false, errorOnExist: false })
    } catch (error) {
      errors.push(`copy failed for ${entry}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  return { packs: await scanTarget(targetDir), errors }
}

/**
 * Remove a retired bundled id only when its spritesheet is byte-for-byte the
 * same as the replacement. User-modified packs are deliberately preserved.
 */
export async function retireBundledAlias(
  targetDir: string,
  legacyId: string,
  replacementDir: string,
): Promise<boolean> {
  const legacyDir = join(targetDir, legacyId)
  const [legacy, replacement] = await Promise.all([
    loadPack(legacyDir),
    loadPack(replacementDir),
  ])
  if (legacy?.id !== legacyId || replacement === null) return false

  const [legacySpritesheet, replacementSpritesheet] = await Promise.all([
    readFile(join(legacy.directory, legacy.spritesheetPath)),
    readFile(join(replacement.directory, replacement.spritesheetPath)),
  ])
  if (!legacySpritesheet.equals(replacementSpritesheet)) return false

  await rm(legacyDir, { recursive: true, force: true })
  return true
}

/** Enumerate valid packs already present in the target directory. */
export async function scanTarget(targetDir: string): Promise<PetPack[]> {
  let entries: string[] = []
  try {
    entries = await readdir(targetDir)
  } catch {
    return []
  }
  const packs: PetPack[] = []
  for (const entry of entries) {
    const pack = await loadPack(join(targetDir, entry))
    if (pack !== null) packs.push(pack)
  }
  return packs
}

/** Resolve the selected pack id, falling back to the first pack. */
export function resolveSelection(packs: PetPack[], requestedId: string): PetPack | undefined {
  if (requestedId !== '') {
    const exact = packs.find(pack => pack.id === requestedId)
    if (exact !== undefined) return exact
  }
  return packs[0]
}
