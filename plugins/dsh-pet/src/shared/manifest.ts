/**
 * Codex pet manifest (`pet.json`) schema and validation.
 *
 * Manifest keys observed in the reference packs: `id`, `displayName`,
 * `description`, `kind` (optional), `spriteVersionNumber` (optional; 2 → v2,
 * omitted → v1), `spritesheetPath`.
 */

export interface PetManifest {
  id: string
  displayName: string
  description?: string
  kind?: string
  spriteVersionNumber?: 1 | 2
  spritesheetPath: string
}

const ID_PATTERN = /^[A-Za-z0-9._-]+$/

/** Parse an unknown JSON value into a validated manifest, throwing on invalid input. */
export function parsePetManifest(raw: string): PetManifest {
  let value: unknown
  try {
    value = JSON.parse(raw)
  } catch {
    throw new Error('pet.json is not valid JSON')
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('pet.json must be a JSON object')
  }
  const record = value as Record<string, unknown>

  const id = record.id
  if (typeof id !== 'string' || !ID_PATTERN.test(id)) {
    throw new Error('pet.json id must be a non-empty [A-Za-z0-9._-]+ string')
  }
  const displayName = record.displayName
  if (typeof displayName !== 'string' || displayName.length === 0) {
    throw new Error('pet.json displayName must be a non-empty string')
  }
  if (record.description !== undefined && typeof record.description !== 'string') {
    throw new Error('pet.json description must be a string when present')
  }
  if (record.kind !== undefined && typeof record.kind !== 'string') {
    throw new Error('pet.json kind must be a string when present')
  }
  const spriteVersionNumber = record.spriteVersionNumber
  if (spriteVersionNumber !== undefined && spriteVersionNumber !== 1 && spriteVersionNumber !== 2) {
    throw new Error('pet.json spriteVersionNumber must be 1 or 2 when present')
  }
  const spritesheetPath = record.spritesheetPath
  if (typeof spritesheetPath !== 'string' || spritesheetPath.length === 0) {
    throw new Error('pet.json spritesheetPath must be a non-empty string')
  }

  return {
    id,
    displayName,
    ...(typeof record.description === 'string' ? { description: record.description } : {}),
    ...(typeof record.kind === 'string' ? { kind: record.kind } : {}),
    ...(spriteVersionNumber === 1 || spriteVersionNumber === 2 ? { spriteVersionNumber } : {}),
    spritesheetPath,
  }
}
