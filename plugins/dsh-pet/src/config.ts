import z from '@deepseek-ai/schemastery'

export const DEFAULT_SOURCE_DIR = '~/.codex/pets'
export const DEFAULT_PET_SIZE = 112
export const MIN_PET_SIZE = 80
export const MAX_PET_SIZE = 224
export const PET_ASPECT_NUMERATOR = 192
export const PET_ASPECT_DENOMINATOR = 208

/** Static plugin configuration, sourced from the cordis.patch.yml default. */
export interface Config {
  /** Whether the desktop pet is enabled. */
  enabled: boolean
  /** Directory of Codex pet packs to copy from (read-only). */
  sourceDir: string
  /** Id of the initially selected pet; empty selects the first scanned pack. */
  petId: string
  /** Pet sprite width in px, clamped 80–224 (192:208 aspect). */
  petSize: number
  /** Initial panel quadrant: one of top-start / top-end / bottom-start / bottom-end. */
  startQuadrant: string
}

export const Config: z<Config> = z.object({
  enabled: z.boolean().default(true),
  sourceDir: z.string().min(1).default(DEFAULT_SOURCE_DIR),
  petId: z.string().default(''),
  petSize: z.number().step(1).min(MIN_PET_SIZE).max(MAX_PET_SIZE).default(DEFAULT_PET_SIZE),
  startQuadrant: z.string().min(1).default('bottom-end'),
})

/**
 * Runtime-adjustable subset of the plugin configuration, exposed through the
 * host settings provider so the Web Settings page can live-edit it. The
 * deployment-only fields (`sourceDir`, `startQuadrant`) stay in the static
 * `Config` above and are not user-editable from the card.
 */
export interface PetSettings {
  /** Whether the desktop pet is shown. */
  enabled: boolean
  /** Selected pet id; empty selects the first scanned pack. */
  petId: string
  /** Pet sprite width in px, clamped 80–224 (192:208 aspect). */
  petSize: number
}

export const PetSettings: z<PetSettings> = z.object({
  enabled: z.boolean().default(true),
  petId: z.string().default(''),
  petSize: z.number().step(1).min(MIN_PET_SIZE).max(MAX_PET_SIZE).default(DEFAULT_PET_SIZE),
})
