/**
 * Runtime window-position persistence under `DSH_HOME/desktop-pet/state.json`.
 * Pet selection and size are owned by the host settings provider
 * (`desktop-pet` namespace); this store keeps only the latest pet coordinate so
 * it survives restarts independently of settings. New writes persist the
 * pet's bottom-center screen anchor rather than the resizable panel origin, so
 * task-card growth cannot move the pet. Legacy panel origins remain readable.
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

/** Screen coordinate in AppKit's y-up coordinate space. */
export interface Position {
  x: number
  y: number
}

export type PositionMode = 'panel-origin' | 'pet-anchor'

export interface PanelState {
  /** Latest coordinate in the space described by `positionMode`. */
  position: Position | null
  /** Missing legacy values are interpreted as a panel origin. */
  positionMode: PositionMode
}

function parsePosition(value: unknown): Position | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
  const record = value as Record<string, unknown>
  if (typeof record.x !== 'number' || typeof record.y !== 'number') return null
  if (!Number.isFinite(record.x) || !Number.isFinite(record.y)) return null
  return { x: record.x, y: record.y }
}

function parsePositionMode(value: unknown): PositionMode {
  return value === 'pet-anchor' ? 'pet-anchor' : 'panel-origin'
}

export class PanelStateStore {
  private state: PanelState | undefined

  constructor(private readonly file: string) {}

  async load(): Promise<PanelState> {
    if (this.state !== undefined) return this.state
    let parsed: unknown
    try {
      parsed = JSON.parse(await readFile(this.file, 'utf8'))
    } catch {
      parsed = undefined
    }
    const value = typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : {}
    this.state = {
      position: parsePosition(value.position),
      positionMode: parsePositionMode(value.positionMode),
    }
    return this.state
  }

  async update(patch: { position?: Position | null; positionMode?: PositionMode }): Promise<PanelState> {
    const current = await this.load()
    if (patch.position !== undefined) current.position = patch.position
    if (patch.positionMode !== undefined) current.positionMode = patch.positionMode
    await mkdir(dirname(this.file), { recursive: true })
    await writeFile(this.file, JSON.stringify(current, null, 2), 'utf8')
    return current
  }
}
