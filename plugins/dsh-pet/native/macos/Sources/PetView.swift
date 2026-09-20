import AppKit

/// Status bubble text shown above the pet.
struct BubbleText: Equatable {
    let stage: String
    let message: String
    let detail: String?
}

/// One row in the pet's task list — clickable to open its chat window.
struct TaskRow: Equatable {
    let id: String
    let title: String
    let state: String // "running" | "waiting" | "review" | "failed"
    let stage: String
    let summary: String
    let detail: String?
    let action: String
}

/// Draws the current sprite frame plus an optional status bubble. The view
/// fills the borderless panel's content view; the pet cell sits in the
/// bottom-anchored `petRect` and the bubble (when present) floats above it.
final class PetView: NSView {
    static let bubbleGap: CGFloat = 6
    static let bubblePaddingX: CGFloat = 10
    static let bubblePaddingY: CGFloat = 6
    static let bubbleMaxWidth: CGFloat = 260
    static let lineHeight: CGFloat = 17
    static let taskMinWidth: CGFloat = 320
    static let taskMaxWidth: CGFloat = 380
    static let taskHeaderHeight: CGFloat = 28
    static let taskRowPaddingY: CGFloat = 8
    static let taskSummaryHeight: CGFloat = 32
    static let taskMetaHeight: CGFloat = 15

    var spritesheet: CGImage? {
        didSet { needsDisplay = true }
    }
    var atlas: AtlasLayout? {
        didSet { needsDisplay = true }
    }
    var currentFrame: FrameRef = FrameRef(columnIndex: 0, rowIndex: 0, frameDurationMs: 0) {
        didSet { needsDisplay = true }
    }
    var bubble: BubbleText? {
        didSet { needsDisplay = true }
    }
    /// Task list (one row per concurrent session), shown above the pet. When
    /// non-empty it takes precedence over the legacy single bubble.
    var tasks: [TaskRow] = [] {
        didSet {
            hoveredTaskIndex = nil
            needsDisplay = true
            window?.invalidateCursorRects(for: self)
        }
    }
    /// Bottom-anchored rect (in view coords) the pet sprite is drawn into.
    var petRect: NSRect = .zero {
        didSet { needsDisplay = true }
    }

    // Mouse event closures, wired by PetController.
    var onMouseEnter: (() -> Void)?
    var onMouseExit: (() -> Void)?
    var onMouseMove: ((CGPoint) -> Void)?      // window coords
    var onMouseDown: ((CGPoint) -> Void)?      // global screen coords
    var onMouseDrag: ((CGPoint) -> Void)?      // global screen coords
    var onMouseUp: (() -> Void)?
    var onRightMouseDown: ((NSEvent) -> Void)?
    var onTaskClick: ((Int) -> Void)?

    private var hoveredTaskIndex: Int?
    private var consumedTaskClick = false
    private var petInteractionActive = false

    override var acceptsFirstResponder: Bool { true }

    /// Width/height the bubble needs for the given text, capped at the max width.
    static func bubbleSize(for bubble: BubbleText) -> NSSize {
        let line1 = NSMutableAttributedString()
        line1.append(NSAttributedString(string: bubble.stage + " ", attributes: [
            .font: NSFont.boldSystemFont(ofSize: 11),
        ]))
        line1.append(NSAttributedString(string: bubble.message, attributes: [
            .font: NSFont.systemFont(ofSize: 12),
        ]))
        var maxTextWidth = line1.size().width
        if let detail = bubble.detail {
            let detailText = NSAttributedString(string: detail, attributes: [
                .font: NSFont.systemFont(ofSize: 11),
            ])
            maxTextWidth = max(maxTextWidth, detailText.size().width)
        }
        let width = min(bubbleMaxWidth, maxTextWidth) + 2 * bubblePaddingX
        let lines: CGFloat = bubble.detail != nil ? 2 : 1
        let height = lines * lineHeight + 2 * bubblePaddingY
        return NSSize(width: width, height: height)
    }

    /// The bubble rect sits above the pet, horizontally centered on it.
    func bubbleRect(for bubble: BubbleText) -> NSRect {
        let size = PetView.bubbleSize(for: bubble)
        let x = petRect.midX - size.width / 2
        let y = petRect.maxY + PetView.bubbleGap
        return NSRect(x: x, y: y, width: size.width, height: size.height)
    }

    /// Height of a single task row: identity, concrete status, then metadata/action.
    static func taskRowHeight(_ row: TaskRow) -> CGFloat {
        return lineHeight + taskSummaryHeight + taskMetaHeight + 2 * taskRowPaddingY
    }

    /// Width/height the task list needs, capped at the max width.
    static func taskListSize(for tasks: [TaskRow]) -> NSSize {
        var maxTextWidth = taskMinWidth - 2 * bubblePaddingX
        for row in tasks {
            let stage = NSAttributedString(string: "● " + row.stage + " ", attributes: [
                .font: NSFont.boldSystemFont(ofSize: 11),
            ])
            let title = NSAttributedString(string: row.title, attributes: [
                .font: NSFont.systemFont(ofSize: 12, weight: .semibold),
            ])
            var width = stage.size().width + title.size().width
            let summary = NSAttributedString(string: row.summary, attributes: [
                .font: NSFont.systemFont(ofSize: 11),
            ])
            width = max(width, summary.size().width)
            if let detail = row.detail {
                let detailText = NSAttributedString(string: detail, attributes: [
                    .font: NSFont.systemFont(ofSize: 10),
                ])
                let actionText = NSAttributedString(string: row.action + " ›", attributes: [
                    .font: NSFont.systemFont(ofSize: 10, weight: .medium),
                ])
                width = max(width, detailText.size().width + actionText.size().width + 16)
            }
            maxTextWidth = max(maxTextWidth, width)
        }
        let width = min(taskMaxWidth, max(taskMinWidth, maxTextWidth + 2 * bubblePaddingX))
        let height = taskHeaderHeight + tasks.reduce(CGFloat(0)) { $0 + taskRowHeight($1) }
        return NSSize(width: width, height: height)
    }

    /// The task list sits above the pet, horizontally centered on it.
    func taskListRect(for tasks: [TaskRow]) -> NSRect {
        let size = PetView.taskListSize(for: tasks)
        let x = petRect.midX - size.width / 2
        let y = petRect.maxY + PetView.bubbleGap
        return NSRect(x: x, y: y, width: size.width, height: size.height)
    }

    /// Index of the task row under a view-coordinate point, or nil if none.
    func taskIndex(at point: CGPoint) -> Int? {
        guard !tasks.isEmpty else { return nil }
        let rect = taskListRect(for: tasks)
        guard rect.contains(point) else { return nil }
        var y = rect.maxY - PetView.taskHeaderHeight
        for (index, row) in tasks.enumerated() {
            let height = PetView.taskRowHeight(row)
            let rowRect = NSRect(x: rect.minX, y: y - height, width: rect.width, height: height)
            if rowRect.contains(point) { return index }
            y -= height
        }
        return nil
    }

    override func draw(_ dirtyRect: NSRect) {
        super.draw(dirtyRect)
        drawPet(in: petRect)
        if !tasks.isEmpty {
            drawTaskList(tasks, in: taskListRect(for: tasks))
        } else if let bubble = bubble {
            drawBubble(bubble, in: bubbleRect(for: bubble))
        }
    }

    private func drawPet(in rect: NSRect) {
        guard let sheet = spritesheet, let atlas = atlas else { return }
        let cx = currentFrame.columnIndex * atlas.cellWidth
        let cy = currentFrame.rowIndex * atlas.cellHeight
        let cell = CGRect(x: cx, y: cy, width: atlas.cellWidth, height: atlas.cellHeight)
        guard let sub = sheet.cropping(to: cell) else { return }
        let target = aspectFit(size: CGSize(width: atlas.cellWidth, height: atlas.cellHeight), in: rect)
        guard let context = NSGraphicsContext.current?.cgContext else { return }
        context.saveGState()
        context.interpolationQuality = .high
        // The view is non-flipped (y-up), so CGImage cells draw right-side up
        // with no manual flip.
        context.draw(sub, in: target)
        context.restoreGState()
    }

    private func drawBubble(_ bubble: BubbleText, in rect: NSRect) {
        guard let context = NSGraphicsContext.current?.cgContext else { return }
        context.saveGState()

        let path = NSBezierPath(roundedRect: rect, xRadius: 10, yRadius: 10)
        NSColor(white: 0.12, alpha: 0.88).setFill()
        path.fill()
        NSColor(white: 1.0, alpha: 0.22).setStroke()
        path.lineWidth = 1
        path.stroke()

        let textRect = rect.insetBy(dx: PetView.bubblePaddingX, dy: PetView.bubblePaddingY)

        let stage = NSAttributedString(string: bubble.stage + " ", attributes: [
            .font: NSFont.boldSystemFont(ofSize: 11),
            .foregroundColor: NSColor(white: 1.0, alpha: 1.0),
        ])
        let message = NSAttributedString(string: bubble.message, attributes: [
            .font: NSFont.systemFont(ofSize: 12),
            .foregroundColor: NSColor(white: 1.0, alpha: 0.92),
        ])
        let line1 = NSMutableAttributedString()
        line1.append(stage)
        line1.append(message)

        if let detail = bubble.detail {
            let detailText = NSAttributedString(string: detail, attributes: [
                .font: NSFont.systemFont(ofSize: 11),
                .foregroundColor: NSColor(white: 1.0, alpha: 0.62),
            ])
            line1.draw(in: NSRect(x: textRect.minX, y: textRect.maxY - PetView.lineHeight,
                                  width: textRect.width, height: PetView.lineHeight))
            detailText.draw(in: NSRect(x: textRect.minX, y: textRect.minY,
                                       width: textRect.width, height: PetView.lineHeight))
        } else {
            let y = textRect.midY - PetView.lineHeight / 2
            line1.draw(in: NSRect(x: textRect.minX, y: y, width: textRect.width, height: PetView.lineHeight))
        }

        context.restoreGState()
    }

    private func drawTaskList(_ rows: [TaskRow], in rect: NSRect) {
        guard let context = NSGraphicsContext.current?.cgContext else { return }
        context.saveGState()

        let path = NSBezierPath(roundedRect: rect, xRadius: 10, yRadius: 10)
        NSColor(white: 0.12, alpha: 0.88).setFill()
        path.fill()
        NSColor(white: 1.0, alpha: 0.22).setStroke()
        path.lineWidth = 1
        path.stroke()

        drawTaskHeader(rows, in: NSRect(
            x: rect.minX + PetView.bubblePaddingX,
            y: rect.maxY - PetView.taskHeaderHeight,
            width: rect.width - 2 * PetView.bubblePaddingX,
            height: PetView.taskHeaderHeight
        ))

        var y = rect.maxY - PetView.taskHeaderHeight
        for (index, row) in rows.enumerated() {
            let height = PetView.taskRowHeight(row)
            let fullRowRect = NSRect(x: rect.minX, y: y - height, width: rect.width, height: height)
            if hoveredTaskIndex == index {
                NSColor(white: 1.0, alpha: 0.08).setFill()
                NSBezierPath(rect: fullRowRect).fill()
            }
            if index > 0 {
                NSColor(white: 1.0, alpha: 0.10).setFill()
                NSBezierPath(rect: NSRect(x: rect.minX + PetView.bubblePaddingX,
                                           y: fullRowRect.maxY - 0.5,
                                           width: rect.width - 2 * PetView.bubblePaddingX,
                                           height: 0.5)).fill()
            }
            let rowRect = fullRowRect.insetBy(dx: PetView.bubblePaddingX, dy: 0)
            drawTaskRow(row, in: rowRect)
            y -= height
        }

        context.restoreGState()
    }

    private func drawTaskHeader(_ rows: [TaskRow], in rect: NSRect) {
        let heading = NSAttributedString(string: "任务动态", attributes: [
            .font: NSFont.systemFont(ofSize: 10, weight: .semibold),
            .foregroundColor: NSColor(white: 1.0, alpha: 0.56),
        ])
        let counts = Dictionary(grouping: rows, by: \.state).mapValues(\.count)
        let overview: String
        if let count = counts["waiting"], count > 0 {
            overview = "\(count) 项需要处理"
        } else if let count = counts["failed"], count > 0 {
            overview = "\(count) 项执行失败"
        } else {
            var parts: [String] = []
            if let count = counts["running"], count > 0 { parts.append("\(count) 项进行中") }
            if let count = counts["review"], count > 0 { parts.append("\(count) 项已完成") }
            overview = parts.joined(separator: " · ")
        }
        let status = NSAttributedString(string: overview, attributes: [
            .font: NSFont.systemFont(ofSize: 10),
            .foregroundColor: NSColor(white: 1.0, alpha: 0.42),
            .paragraphStyle: rightAlignedTruncatingStyle(),
        ])
        let y = rect.midY - 7
        heading.draw(in: NSRect(x: rect.minX, y: y, width: 72, height: 15))
        status.draw(in: NSRect(x: rect.minX + 72, y: y, width: rect.width - 72, height: 15))
    }

    private func drawTaskRow(_ row: TaskRow, in rect: NSRect) {
        let dot = NSAttributedString(string: "● ", attributes: [
            .font: NSFont.boldSystemFont(ofSize: 10),
            .foregroundColor: stateColor(row.state),
        ])
        let stage = NSAttributedString(string: row.stage + " ", attributes: [
            .font: NSFont.boldSystemFont(ofSize: 11),
            .foregroundColor: NSColor(white: 1.0, alpha: 0.82),
        ])
        let title = NSAttributedString(string: row.title, attributes: [
            .font: NSFont.systemFont(ofSize: 12, weight: .semibold),
            .foregroundColor: NSColor(white: 1.0, alpha: 0.96),
            .paragraphStyle: truncatingStyle(),
        ])
        let line = NSMutableAttributedString()
        line.append(dot)
        line.append(stage)
        line.append(title)

        line.draw(in: NSRect(x: rect.minX,
                             y: rect.maxY - PetView.taskRowPaddingY - PetView.lineHeight,
                             width: rect.width, height: PetView.lineHeight))

        let summary = NSAttributedString(string: row.summary, attributes: [
            .font: NSFont.systemFont(ofSize: 11),
            .foregroundColor: NSColor(white: 1.0, alpha: 0.78),
            .paragraphStyle: twoLineTruncatingStyle(),
        ])
        let summaryY = rect.maxY - PetView.taskRowPaddingY - PetView.lineHeight - PetView.taskSummaryHeight
        summary.draw(in: NSRect(x: rect.minX, y: summaryY,
                                width: rect.width, height: PetView.taskSummaryHeight))

        let metaY = rect.minY + PetView.taskRowPaddingY
        if let detail = row.detail {
            let detailText = NSAttributedString(string: detail, attributes: [
                .font: NSFont.systemFont(ofSize: 10),
                .foregroundColor: NSColor(white: 1.0, alpha: 0.48),
                .paragraphStyle: truncatingStyle(),
            ])
            detailText.draw(in: NSRect(x: rect.minX, y: metaY,
                                       width: max(0, rect.width - 88), height: PetView.taskMetaHeight))
        }
        let actionText = NSAttributedString(string: row.action + " ›", attributes: [
            .font: NSFont.systemFont(ofSize: 10, weight: .medium),
            .foregroundColor: stateColor(row.state).withAlphaComponent(0.92),
            .paragraphStyle: rightAlignedTruncatingStyle(),
        ])
        actionText.draw(in: NSRect(x: rect.maxX - 88, y: metaY,
                                   width: 88, height: PetView.taskMetaHeight))
    }

    private func truncatingStyle() -> NSParagraphStyle {
        let style = NSMutableParagraphStyle()
        style.lineBreakMode = .byTruncatingTail
        return style
    }

    private func rightAlignedTruncatingStyle() -> NSParagraphStyle {
        let style = NSMutableParagraphStyle()
        style.alignment = .right
        style.lineBreakMode = .byTruncatingTail
        return style
    }

    private func twoLineTruncatingStyle() -> NSParagraphStyle {
        let style = NSMutableParagraphStyle()
        style.lineBreakMode = .byTruncatingTail
        style.lineSpacing = 1
        return style
    }

    private func stateColor(_ state: String) -> NSColor {
        switch state {
        case "waiting": return NSColor(calibratedRed: 0.95, green: 0.72, blue: 0.24, alpha: 1.0)
        case "failed": return NSColor(calibratedRed: 0.95, green: 0.36, blue: 0.36, alpha: 1.0)
        case "review": return NSColor(calibratedRed: 0.35, green: 0.85, blue: 0.50, alpha: 1.0)
        default: return NSColor(calibratedRed: 0.45, green: 0.65, blue: 0.95, alpha: 1.0)
        }
    }

    private func aspectFit(size: CGSize, in container: NSRect) -> NSRect {
        let scale = min(container.width / size.width, container.height / size.height)
        let width = size.width * scale
        let height = size.height * scale
        return NSRect(x: container.midX - width / 2, y: container.midY - height / 2, width: width, height: height)
    }

    override func mouseEntered(with event: NSEvent) { onMouseEnter?() }
    override func mouseExited(with event: NSEvent) {
        hoveredTaskIndex = nil
        needsDisplay = true
        onMouseExit?()
    }
    override func mouseMoved(with event: NSEvent) {
        let point = convert(event.locationInWindow, from: nil)
        let nextIndex = taskIndex(at: point)
        if nextIndex != hoveredTaskIndex {
            hoveredTaskIndex = nextIndex
            needsDisplay = true
        }
        onMouseMove?(event.locationInWindow)
    }
    override func mouseDown(with event: NSEvent) {
        let point = convert(event.locationInWindow, from: nil)
        if let index = taskIndex(at: point) {
            consumedTaskClick = true
            petInteractionActive = false
            onTaskClick?(index)
            return
        }
        consumedTaskClick = false
        guard petRect.contains(point) else {
            petInteractionActive = false
            return
        }
        petInteractionActive = true
        onMouseDown?(NSEvent.mouseLocation)
    }
    override func mouseDragged(with event: NSEvent) {
        guard petInteractionActive else { return }
        onMouseDrag?(NSEvent.mouseLocation)
    }
    override func mouseUp(with event: NSEvent) {
        if consumedTaskClick {
            consumedTaskClick = false
            return
        }
        guard petInteractionActive else { return }
        petInteractionActive = false
        onMouseUp?()
    }
    override func rightMouseDown(with event: NSEvent) { onRightMouseDown?(event) }

    override func resetCursorRects() {
        super.resetCursorRects()
        guard !tasks.isEmpty else { return }
        let rect = taskListRect(for: tasks)
        var y = rect.maxY - PetView.taskHeaderHeight
        for row in tasks {
            let height = PetView.taskRowHeight(row)
            addCursorRect(NSRect(x: rect.minX, y: y - height, width: rect.width, height: height),
                          cursor: .pointingHand)
            y -= height
        }
    }
}
