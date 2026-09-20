/**
 * Codex pet animation engine, reverse-engineered to exact parity from the
 * ChatGPT pet renderer (`app-initial` bundle).
 *
 * Naming mirrors the original for auditability:
 * - `i4(row, count, baseMs, lastMs)` — frame builder.
 * - `Jlo` — idle base frames (row 0), `Ylo` — idle frames × 6.
 * - `Xlo` — state → frame list.
 * - `Ulo(state, isStatic)` — animation sequence.
 * - `Glo(frame, rowCount)` — CSS background-position.
 * - `auo(rect, cursor, version)` — look-direction frame (v2 only).
 */

import type { AtlasLayout, SpriteVersion } from './atlas.js'
import { ATLAS_V1, ATLAS_V2, rowCountForVersion } from './atlas.js'
import type { PetState } from './state.js'

export interface FrameRef {
  columnIndex: number
  rowIndex: number
  frameDurationMs: number
}

export interface AnimationSequence {
  frames: FrameRef[]
  loopStartIndex: number | null
}

/** 6× duration multiplier applied to idle frames. */
const IDLE_MULTIPLIER = 6

/** Idle base frames (row 0): slow blink/settle cycle. */
const JLO: FrameRef[] = [
  { rowIndex: 0, columnIndex: 0, frameDurationMs: 280 },
  { rowIndex: 0, columnIndex: 1, frameDurationMs: 110 },
  { rowIndex: 0, columnIndex: 2, frameDurationMs: 110 },
  { rowIndex: 0, columnIndex: 3, frameDurationMs: 140 },
  { rowIndex: 0, columnIndex: 4, frameDurationMs: 140 },
  { rowIndex: 0, columnIndex: 5, frameDurationMs: 320 },
]

const YLO: FrameRef[] = JLO.map(frame => ({ ...frame, frameDurationMs: frame.frameDurationMs * IDLE_MULTIPLIER }))

/** Frame builder: `count` frames in `row`, base duration `baseMs`, last frame `lastMs`. */
function i4(row: number, count: number, baseMs: number, lastMs: number): FrameRef[] {
  return Array.from({ length: count }, (_, column) => ({
    columnIndex: column,
    frameDurationMs: column === count - 1 ? lastMs : baseMs,
    rowIndex: row,
  }))
}

/** State → frame list. Row indices follow the atlas row map (see animation-rows). */
const XLO: Record<Exclude<PetState, 'idle'>, FrameRef[]> = {
  failed: i4(5, 8, 140, 240),
  jumping: i4(4, 5, 140, 280),
  review: i4(8, 6, 150, 280),
  running: i4(7, 6, 120, 220),
  waving: i4(3, 4, 140, 280),
  waiting: i4(6, 6, 150, 260),
  'running-left': i4(2, 8, 120, 220),
  'running-right': i4(1, 8, 120, 220),
}

/** Frame accessor; throws RangeError on out-of-range index (parity with original). */
function wlo(frames: FrameRef[], index: number): FrameRef {
  const frame = frames[index]
  if (frame === undefined) throw new RangeError('Codex pet animation frame is out of range')
  return frame
}

/**
 * Build the animation sequence for a state.
 * - `isStatic`: single frame preview (no loop).
 * - `idle`: `Ylo` frames, loop from index 0.
 * - otherwise: state frames × 3 followed by `Ylo`, loop restarting after the tripled frames.
 */
export function sequenceFor(state: PetState, isStatic = false): AnimationSequence {
  if (isStatic) {
    const frames = state === 'idle' ? JLO : XLO[state]
    return { frames: [wlo(frames, 0)], loopStartIndex: null }
  }
  if (state === 'idle') return { frames: YLO, loopStartIndex: 0 }
  const n = XLO[state]
  const tripled = [...n, ...n, ...n]
  return { frames: [...tripled, ...YLO], loopStartIndex: tripled.length }
}

/** CSS `background-position` for a frame within an atlas of `rowCount` rows. */
export function backgroundPosition(frame: FrameRef, rowCount: number): string {
  const x = (frame.columnIndex / (ATLAS_V2.columns - 1)) * 100
  const y = (frame.rowIndex / (rowCount - 1)) * 100
  return `${x}% ${y}%`
}

/** CSS `background-size` for a full atlas of `rowCount` rows (8 columns fixed). */
export function backgroundSize(rowCount: number): string {
  return `${ATLAS_V2.columns * 100}% ${rowCount * 100}%`
}

export interface PetRect {
  left: number
  top: number
  width: number
  height: number
}

export interface Point {
  x: number
  y: number
}

const LOOK_BUCKET_DEGREES = 22.5
const LOOK_BUCKET_COUNT = 16
const LOOK_ROW_START = 9
const LOOK_COLUMN_COUNT = 8
const LOOK_DEAD_ZONE = 1

/**
 * Look-direction frame toward the cursor. Returns null when outside the dead
 * zone or when the atlas is v1 (no look rows).
 */
export function lookFrame(rect: PetRect, cursor: Point, version: SpriteVersion): FrameRef | null {
  if (version !== ATLAS_V2.version) return null
  const dx = cursor.x - (rect.left + rect.width / 2)
  const dy = cursor.y - (rect.top + rect.height / 2)
  if (Math.hypot(dx, dy) <= LOOK_DEAD_ZONE) return null
  const angle = ((Math.atan2(dx, -dy) * 180) / Math.PI + 360) % 360
  const bucket = Math.round(angle / LOOK_BUCKET_DEGREES) % LOOK_BUCKET_COUNT
  return {
    columnIndex: bucket % LOOK_COLUMN_COUNT,
    frameDurationMs: 0,
    rowIndex: LOOK_ROW_START + Math.floor(bucket / LOOK_COLUMN_COUNT),
  }
}

/** Exposed for tests: the base idle frames and the state frame map. */
export const __internal = { JLO, YLO, XLO, i4, wlo }

export type { AtlasLayout }
export { ATLAS_V1, ATLAS_V2, rowCountForVersion }
