/**
 * Pet states and the display snapshot (sprite animation + status bubble)
 * streamed to the native Helper.
 */

export type PetState =
  | 'idle'
  | 'running'
  | 'waiting'
  | 'failed'
  | 'review'
  | 'waving'
  | 'jumping'
  | 'running-left'
  | 'running-right'

/** States that may display a look-direction frame (v2 only). */
const LOOK_ENABLED_STATES: ReadonlySet<PetState> = new Set(['idle', 'running', 'waving'])

export function supportsLookFrame(state: PetState): boolean {
  return LOOK_ENABLED_STATES.has(state)
}

/** Text shown in the status bubble beside the pet. */
export interface PetBubble {
  /** Short phase label, e.g. "思考中" / "处理中" / "需要确认" / "已完成". */
  stage: string
  /** Human sentence describing what the agent is doing. */
  message: string
  /** Optional second line: project · progress · task. */
  detail?: string
  /** True for transient bubbles (success/error) that fade automatically. */
  pulse?: boolean
  /** Lifetime of a pulse bubble in milliseconds. */
  ttlMs?: number
}

/**
 * Task lifecycle state for a single concurrent session, mirroring Codex's four
 * public task states: Running / Needs input / Ready / Blocked. `idle` sessions
 * are not listed.
 */
export type PetTaskState = 'running' | 'waiting' | 'review' | 'failed'

/** Priority used to pick the pet's animation state; higher wins. */
export const TASK_STATE_PRIORITY: Record<PetTaskState, number> = {
  waiting: 4, // Needs input
  failed: 3, // Blocked
  review: 2, // Ready
  running: 1,
}

/** One row in the pet's task list — clickable to open its chat window. */
export interface PetTask {
  /** Session id; the click target that opens the corresponding chat window. */
  id: string
  /** Short task title: current todo step, else project (cwd) name, else id prefix. */
  title: string
  /** Task lifecycle state, mirroring Codex Running / Needs input / Ready / Blocked. */
  state: PetTaskState
  /** Short stage label for the row, e.g. "思考中" / "需要确认" / "已完成" / "执行失败". */
  stage: string
  /** One concrete sentence explaining the current state or required action. */
  summary: string
  /** Optional metadata line: project · progress · elapsed/status age. */
  detail?: string
  /** Short click affordance rendered on the metadata line. */
  action: string
}

/** A single display snapshot: which animation to play, its task list, plus an optional bubble. */
export interface PetDisplay {
  state: PetState
  bubble: PetBubble | null
  /** Active tasks (one row per concurrent session), highest priority first. */
  tasks: PetTask[]
}
