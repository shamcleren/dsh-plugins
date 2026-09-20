/** Settings-scope projection, live writes, and pet-list fetch for the browser card. */

import type { SettingsScope } from '@deepseek-ai/dsh-client-ui-settings/client'
import type { PetSettings } from '../config.js'
import { canonicalPetId, PET_PACKS_PATH, type PetPickerItem } from '../shared/picker.js'

type SnapshotStore<T> = {
  getSnapshot(): T
  subscribe(listener: () => void): () => void
  set(value: T): void
}

export interface DesktopPetCardState {
  enabled: boolean
  /** Currently selected pet id, resolved from the settings scope. */
  petId: string
  petSizeDraft: string
  /** Pets offered by the thumbnail picker. */
  pets: PetPickerItem[]
  petsLoading: boolean
  petsFailed: boolean
  available: boolean
  writable: boolean
}

export interface DesktopPetCardFace {
  hooks: { desktopPetCard: SnapshotStore<DesktopPetCardState> }
  setEnabled(value: boolean): void
  selectPet(id: string): void
  editPetSize(text: string): void
  commitPetSize(): void
}

const MIN_PET_SIZE = 80
const MAX_PET_SIZE = 224

/** Validate an untrusted picker-route payload into `PetPickerItem` rows. */
export function parsePets(value: unknown): PetPickerItem[] {
  if (!Array.isArray(value)) return []
  const rows: PetPickerItem[] = []
  for (const entry of value) {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) continue
    const record = entry as Record<string, unknown>
    if (typeof record.id !== 'string' || record.id === '') continue
    if (typeof record.displayName !== 'string') continue
    if (typeof record.spriteUrl !== 'string') continue
    if (typeof record.spriteWidth !== 'number' || !Number.isFinite(record.spriteWidth)) continue
    if (typeof record.spriteHeight !== 'number' || !Number.isFinite(record.spriteHeight)) continue
    if (typeof record.cellWidth !== 'number' || !Number.isFinite(record.cellWidth)) continue
    if (typeof record.cellHeight !== 'number' || !Number.isFinite(record.cellHeight)) continue
    rows.push({
      id: record.id,
      displayName: record.displayName,
      version: record.version === 2 ? 2 : 1,
      spriteUrl: record.spriteUrl,
      spriteWidth: record.spriteWidth,
      spriteHeight: record.spriteHeight,
      cellWidth: record.cellWidth,
      cellHeight: record.cellHeight,
    })
  }
  return rows
}

/** Live-editing controller: pet size edits are staged locally, selection commits immediately. */
export class DesktopPetCardController {
  private readonly store: SnapshotStore<DesktopPetCardState>
  private petSizeDraft: string
  private pets: PetPickerItem[] = []
  private petsLoading = true
  private petsFailed = false
  private disposed = false

  constructor(private readonly scope: SettingsScope<PetSettings>) {
    const value = scope.getSnapshot().value
    this.petSizeDraft = value === undefined ? '' : String(value.petSize)
    this.store = createStore(this.projection())
    scope.subscribe(() => {
      const next = scope.getSnapshot().value
      if (next !== undefined) {
        this.petSizeDraft = String(next.petSize)
      }
      this.publish()
    })
    void this.loadPets()
  }

  inject(): DesktopPetCardFace {
    return {
      hooks: { desktopPetCard: this.store },
      setEnabled: value => {
        void this.scope.set('enabled', value)
      },
      selectPet: id => {
        if (id !== this.scope.getSnapshot().value?.petId) void this.scope.set('petId', id)
      },
      editPetSize: text => {
        this.petSizeDraft = text
        this.publish()
      },
      commitPetSize: () => {
        const parsed = Math.trunc(Number(this.petSizeDraft.trim()))
        if (Number.isFinite(parsed) && parsed >= MIN_PET_SIZE && parsed <= MAX_PET_SIZE) {
          void this.scope.set('petSize', parsed)
          return
        }
        const value = this.scope.getSnapshot().value
        this.petSizeDraft = value === undefined ? '' : String(value.petSize)
        this.publish()
      },
    }
  }

  /** Stop background work so a late fetch cannot publish into a dead card. */
  dispose(): void {
    this.disposed = true
  }

  private async loadPets(): Promise<void> {
    try {
      const response = await fetch(PET_PACKS_PATH)
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      this.pets = parsePets(await response.json())
    } catch {
      this.petsFailed = true
    } finally {
      this.petsLoading = false
      if (!this.disposed) this.publish()
    }
  }

  private projection(): DesktopPetCardState {
    const snapshot = this.scope.getSnapshot()
    const value = snapshot.value
    return {
      enabled: value?.enabled ?? true,
      petId: canonicalPetId(value?.petId ?? ''),
      petSizeDraft: this.petSizeDraft,
      pets: this.pets,
      petsLoading: this.petsLoading,
      petsFailed: this.petsFailed,
      available: snapshot.status === 'ready',
      writable: snapshot.writable,
    }
  }

  private publish(): void {
    this.store.set(this.projection())
  }
}

function createStore<S>(initial: S): SnapshotStore<S> {
  let snapshot = initial
  const listeners = new Set<() => void>()
  return {
    getSnapshot: () => snapshot,
    subscribe(listener) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    set(next) {
      snapshot = next
      for (const listener of listeners) listener()
    },
  }
}
