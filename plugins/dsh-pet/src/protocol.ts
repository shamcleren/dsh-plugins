/**
 * Newline-delimited JSON protocol between the host plugin and the bundled
 * native Helper. Each message is a single JSON object terminated by `\n`.
 *
 * Direction "plugin → helper": `config`, `state`, `shutdown`.
 * Direction "helper → plugin": `ready`, `hide`, `move`, `activate`, `closed`.
 * `select` / `resize` are retained for protocol compatibility but are no
 * longer emitted by the helper (pet selection and size live in the Web
 * Settings card instead of the helper's context menu).
 */

import type { PetBubble, PetState, PetTask } from './shared/state.js'
import type { Position, PositionMode } from './state-store.js'

export const PROTOCOL_VERSION = 1

export const MessageKind = {
  READY: 'ready',
  CONFIG: 'config',
  STATE: 'state',
  SELECT: 'select',
  RESIZE: 'resize',
  HIDE: 'hide',
  MOVE: 'move',
  ACTIVATE: 'activate',
  CLOSED: 'closed',
  SHUTDOWN: 'shutdown',
} as const

export type MessageKind = (typeof MessageKind)[keyof typeof MessageKind]

/** A single pet listed in the helper's context menu. */
export interface PetInfo {
  id: string
  displayName: string
  version: 1 | 2
  spritesheetPath: string
}

/** Payload of a `config` message (plugin → helper). */
export interface ConfigPayload {
  /** PID of the exact desktop host that launched this plugin process. */
  hostPid: number
  /** Absolute directory containing one subdirectory per pet pack. */
  packsDir: string
  pets: PetInfo[]
  petId: string
  petSize: number
  /** Default corner used when `position` is null. */
  quadrant: string
  /** Last saved panel origin or pet anchor (screen coordinates), or null. */
  position: Position | null
  /** Interpretation of `position`; legacy state defaults to `panel-origin`. */
  positionMode: PositionMode
}

/** Payload of a `state` message (plugin → helper). */
export interface StatePayload {
  state: PetState
  /** Status bubble text, or null to hide the bubble. */
  bubble: PetBubble | null
  /** Active task list (one row per concurrent session), highest priority first. */
  tasks: PetTask[]
}

/** Payload of an `activate` message (helper → plugin): open a chat window. */
export interface ActivatePayload {
  /** Session id whose chat window the user clicked. */
  sessionId: string
}

export interface CompanionMessage {
  protocolVersion: number
  kind: MessageKind
  timestamp: number
  [key: string]: unknown
}

export function createMessage(kind: MessageKind, payload: Record<string, unknown> = {}): CompanionMessage {
  return { protocolVersion: PROTOCOL_VERSION, kind, timestamp: Date.now(), ...payload }
}

export function encodeMessage(message: CompanionMessage): string {
  return `${JSON.stringify(message)}\n`
}

/** Validate an unknown parsed value as a protocol message, or return null. */
export function assertCompanionMessage(value: unknown): CompanionMessage | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
  const record = value as Record<string, unknown>
  if (record.protocolVersion !== PROTOCOL_VERSION) return null
  const kind = record.kind
  if (typeof kind !== 'string' || !(Object.values(MessageKind) as string[]).includes(kind)) return null
  return value as CompanionMessage
}
