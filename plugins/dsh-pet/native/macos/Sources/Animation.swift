import Foundation

/// Codex pet animation engine, ported 1:1 from the plugin's
/// `shared/animation.ts`. Naming mirrors the original for auditability.
///
/// - `i4(row, count, baseMs, lastMs)` — frame builder.
/// - `jlo` — idle base frames (row 0), `ylo` — idle frames × 6.
/// - `xlo` — state → frame list.
/// - `sequenceFor(state, isStatic)` — animation sequence.
/// - `lookFrame(rect, cursor, version)` — look-direction frame (v2 only).

struct FrameRef {
    let columnIndex: Int
    let rowIndex: Int
    let frameDurationMs: Int
}

struct AnimationSequence {
    let frames: [FrameRef]
    /// Loop-back index, or nil for a static (non-looping) sequence.
    let loopStartIndex: Int?
}

enum PetState: String {
    case idle = "idle"
    case running = "running"
    case waiting = "waiting"
    case failed = "failed"
    case review = "review"
    case waving = "waving"
    case jumping = "jumping"
    case runningLeft = "running-left"
    case runningRight = "running-right"
}

private let idleMultiplier = 6

private let jlo: [FrameRef] = [
    FrameRef(columnIndex: 0, rowIndex: 0, frameDurationMs: 280),
    FrameRef(columnIndex: 1, rowIndex: 0, frameDurationMs: 110),
    FrameRef(columnIndex: 2, rowIndex: 0, frameDurationMs: 110),
    FrameRef(columnIndex: 3, rowIndex: 0, frameDurationMs: 140),
    FrameRef(columnIndex: 4, rowIndex: 0, frameDurationMs: 140),
    FrameRef(columnIndex: 5, rowIndex: 0, frameDurationMs: 320),
]

private let ylo: [FrameRef] = jlo.map {
    FrameRef(columnIndex: $0.columnIndex, rowIndex: $0.rowIndex, frameDurationMs: $0.frameDurationMs * idleMultiplier)
}

private func i4(_ row: Int, _ count: Int, _ baseMs: Int, _ lastMs: Int) -> [FrameRef] {
    (0..<count).map { column in
        FrameRef(columnIndex: column, rowIndex: row, frameDurationMs: column == count - 1 ? lastMs : baseMs)
    }
}

private let xlo: [PetState: [FrameRef]] = [
    .failed: i4(5, 8, 140, 240),
    .jumping: i4(4, 5, 140, 280),
    .review: i4(8, 6, 150, 280),
    .running: i4(7, 6, 120, 220),
    .waving: i4(3, 4, 140, 280),
    .waiting: i4(6, 6, 150, 260),
    .runningLeft: i4(2, 8, 120, 220),
    .runningRight: i4(1, 8, 120, 220),
]

func sequenceFor(_ state: PetState, isStatic: Bool = false) -> AnimationSequence {
    if isStatic {
        let frames = state == .idle ? jlo : (xlo[state] ?? jlo)
        return AnimationSequence(frames: Array(frames.prefix(1)), loopStartIndex: nil)
    }
    if state == .idle { return AnimationSequence(frames: ylo, loopStartIndex: 0) }
    let n = xlo[state] ?? jlo
    let tripled = n + n + n
    return AnimationSequence(frames: tripled + ylo, loopStartIndex: tripled.count)
}

let lookEnabledStates: Set<PetState> = [.idle, .running, .waving]

/// Look-direction frame toward `cursor`. AppKit uses a bottom-left (y-up)
/// origin, so the y term is not negated (unlike the CSS original's
/// `atan2(dx, -dy)`).
func lookFrame(rect: CGRect, cursor: CGPoint, version: Int) -> FrameRef? {
    guard version == 2 else { return nil }
    let dx = cursor.x - rect.midX
    let dy = cursor.y - rect.midY
    if hypot(dx, dy) <= 1 { return nil }
    let angle = (atan2(dx, dy) * 180 / .pi + 360).truncatingRemainder(dividingBy: 360)
    let bucket = Int((angle / 22.5).rounded()) % 16
    return FrameRef(columnIndex: bucket % 8, rowIndex: 9 + bucket / 8, frameDurationMs: 0)
}
