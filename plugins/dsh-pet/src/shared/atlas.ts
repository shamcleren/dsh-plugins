/**
 * Codex pet atlas layout, reverse-engineered from the ChatGPT pet renderer and
 * verified against the reference pet packs (`1536×1872` v1, `1536×2288` v2).
 *
 * The atlas is selected by pixel dimensions, not by the manifest version field.
 */

export type SpriteVersion = 1 | 2

export interface AtlasLayout {
  version: SpriteVersion
  width: number
  height: number
  cellWidth: number
  cellHeight: number
  columns: number
  rows: number
  /** Max frame count per row, used only to validate a frame reference. */
  requiredFramesByRow: number[]
}

export const ATLAS_V1: AtlasLayout = {
  version: 1,
  width: 1536,
  height: 1872,
  cellWidth: 192,
  cellHeight: 208,
  columns: 8,
  rows: 9,
  requiredFramesByRow: [6, 8, 8, 4, 5, 8, 6, 6, 6],
}

export const ATLAS_V2: AtlasLayout = {
  version: 2,
  width: 1536,
  height: 2288,
  cellWidth: 192,
  cellHeight: 208,
  columns: 8,
  rows: 11,
  requiredFramesByRow: [6, 8, 8, 4, 5, 8, 6, 6, 6, 8, 8],
}

const ATLASES: AtlasLayout[] = [ATLAS_V1, ATLAS_V2]

/** Select the atlas that matches the given pixel dimensions, or null. */
export function atlasForDimensions(width: number, height: number): AtlasLayout | null {
  return ATLASES.find(atlas => atlas.width === width && atlas.height === height) ?? null
}

/** Row count for a manifest sprite version (default 1 when omitted). */
export function rowCountForVersion(version: number | undefined): number {
  return version === 2 ? 11 : 9
}
