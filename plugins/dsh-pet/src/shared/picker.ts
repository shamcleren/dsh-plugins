/**
 * Shared contract between the host picker route (`src/server.ts`) and the
 * browser settings card (`src/client/`). Kept dependency-free so the client
 * bundle can import it without pulling in node-only host code.
 *
 * The routes deliberately live outside `/api/`: that prefix is owned by
 * `dsh-client-connection` and enforces Host/Origin fencing plus a browser
 * cookie, which would 401 the thumbnail fetches. These are read-only,
 * loopback-served, non-sensitive assets (pet list + the user's own
 * spritesheets), so they are public like non-index static assets.
 */

export const PET_PACKS_PATH = '/desktop-pet/packs'
export const PET_SPRITE_PATH = '/desktop-pet/sprite'
export const PET_ID_ALIASES: Readonly<Record<string, string>> = {
  langma: 'xiaobai',
  'langma-no-wave': 'xiaobai-no-wave',
}
export const RETIRED_PET_IDS = Object.freeze(Object.keys(PET_ID_ALIASES))

/** Keep persisted selections working after a bundled pet id is renamed. */
export function canonicalPetId(petId: string): string {
  return PET_ID_ALIASES[petId] ?? petId
}

/**
 * Polled by the resident client bundle. Returns the next session id the user
 * clicked in the pet's task list (consumed once), or 204 when none is pending.
 */
export const PET_ACTIVATE_PATH = '/desktop-pet/activate'

/** One pet row handed to the browser thumbnail picker. */
export interface PetPickerItem {
  id: string
  displayName: string
  version: 1 | 2
  /** Absolute-path URL of the pack's spritesheet, served by the host. */
  spriteUrl: string
  spriteWidth: number
  spriteHeight: number
  cellWidth: number
  cellHeight: number
}
