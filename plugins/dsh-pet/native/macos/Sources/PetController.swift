import AppKit

struct PetInfo {
    let id: String
    let displayName: String
    let version: Int
    let spritesheetPath: String
}

/// Owns the transparent always-on-top panel and the sprite animation loop.
/// Receives `config` / `state` / `shutdown` from the plugin and reports
/// `ready` / `select` / `resize` / `move` / `closed` back over stdio.
final class PetController: NSObject, NSWindowDelegate {
    static let padding: CGFloat = 8
    static let cellAspect = CGFloat(192) / CGFloat(208) // width / height
    /// Small pointer jitter is still a click. This is deliberately more
    /// forgiving than the previous 3-point per-axis threshold.
    static let dragActivationDistance: CGFloat = 6

    private let panel: NSPanel
    private let petView = PetView()
    private let protocolIO: StdioProtocol

    private var timer: Timer?
    private var sequence = AnimationSequence(frames: [], loopStartIndex: nil)
    private var frameIndex = 0
    private var elapsedMs: Double = 0

    private var baseState: PetState = .idle
    private var hoverActive = false
    private var lookFrameRef: FrameRef?
    private var wavingUntil: Date?
    private var cursorWindow = CGPoint.zero

    private var packsDir = ""
    private var pets: [PetInfo] = []
    private var petId = ""
    private var petSize = 112
    /// PID of the exact Harness desktop process that owns the plugin host.
    /// Using a PID avoids selecting the wrong instance when development and
    /// packaged Harness apps are both running.
    private var hostProcessIdentifier: pid_t?
    private var defaultQuadrant = "bottom-end"
    private var savedPosition: CGPoint?
    private var savedPositionMode = "panel-origin"
    /// The persisted position is restored exactly once. Subsequent config
    /// pushes (for example, a size change) preserve the live pet anchor.
    private var didRestorePosition = false
    /// Stable screen-space point at the bottom centre of the pet. The panel
    /// may grow in either direction as cards change, but this point stays put.
    private var petScreenAnchor: CGPoint?
    private var atlas: AtlasLayout?

    private var dragOrigin: CGPoint = .zero
    private var mouseDownGlobal: CGPoint = .zero
    private var dragged = false
    /// True while the user is actively dragging; suppresses the look frame so
    /// the direction-matching run cycle plays instead.
    private var dragging = false
    /// The run direction currently playing during a drag, to avoid restarting
    /// the sequence on every mouse-move tick.
    private var dragState: PetState = .idle

    /// Current status bubble text (nil hides the bubble).
    private var bubble: BubbleText?
    /// Current task list (one row per concurrent session); takes precedence
    /// over `bubble` when non-empty.
    private var tasks: [TaskRow] = []

    init(protocolIO: StdioProtocol) {
        self.protocolIO = protocolIO
        let size = PetController.windowSize(for: 112)
        panel = NSPanel(
            contentRect: NSRect(origin: .zero, size: size),
            styleMask: [.borderless, .nonactivatingPanel],
            backing: .buffered,
            defer: false
        )
        super.init()
        panel.isOpaque = false
        panel.backgroundColor = .clear
        panel.hasShadow = false
        panel.level = .floating
        panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]
        panel.isMovableByWindowBackground = false
        panel.hidesOnDeactivate = false
        panel.isReleasedWhenClosed = false
        panel.delegate = self
        panel.contentView = petView

        petView.onMouseEnter = { [weak self] in self?.mouseEntered() }
        petView.onMouseExit = { [weak self] in self?.mouseExited() }
        petView.onMouseMove = { [weak self] in self?.mouseMoved($0) }
        petView.onMouseDown = { [weak self] in self?.mouseDowned($0) }
        petView.onMouseDrag = { [weak self] in self?.mouseDraggedTo($0) }
        petView.onMouseUp = { [weak self] in self?.mouseUpped() }
        petView.onRightMouseDown = { [weak self] in self?.showMenu($0) }
        petView.onTaskClick = { [weak self] index in
            guard let self = self, index >= 0, index < self.tasks.count else { return }
            self.protocolIO.send(kind: "activate", payload: ["sessionId": self.tasks[index].id])
            self.focusHostApplication()
        }

        installTrackingArea()
    }

    func show() {
        applyLayout()
        panel.orderFrontRegardless()
        startTimer()
        protocolIO.send(kind: "ready")
    }

    func handle(_ message: [String: Any]) {
        guard let kind = message["kind"] as? String else { return }
        switch kind {
        case "config":
            applyConfig(message)
        case "state":
            if let raw = message["state"] as? String, let state = PetState(rawValue: raw) {
                baseState = state
            }
            let nextBubble = Self.parseBubble(message["bubble"])
            let nextTasks = Self.parseTasks(message["tasks"])
            if nextBubble != bubble || nextTasks != tasks {
                bubble = nextBubble
                tasks = nextTasks
                petView.bubble = nextBubble
                petView.tasks = nextTasks
                applyLayout()
            }
            if !hoverActive && wavingUntil == nil {
                applyBaseSequence()
            }
        case "shutdown":
            // Take one final position snapshot before acknowledging shutdown.
            // The host waits for `closed` and flushes the queued `move` write,
            // so a quit immediately after dragging cannot lose the last anchor.
            if didRestorePosition {
                reportCurrentPosition()
            }
            protocolIO.send(kind: "closed")
            NSApp.terminate(nil)
        default:
            break
        }
    }

    private static func parseBubble(_ value: Any?) -> BubbleText? {
        guard let dict = value as? [String: Any],
              let stage = dict["stage"] as? String,
              let message = dict["message"] as? String else { return nil }
        let detail = dict["detail"] as? String
        return BubbleText(stage: stage, message: message, detail: detail)
    }

    private static func parseTasks(_ value: Any?) -> [TaskRow] {
        guard let list = value as? [[String: Any]] else { return [] }
        return list.compactMap { item in
            guard let id = item["id"] as? String,
                  let title = item["title"] as? String,
                  let state = item["state"] as? String,
                  let stage = item["stage"] as? String,
                  let summary = item["summary"] as? String,
                  let action = item["action"] as? String else { return nil }
            return TaskRow(id: id, title: title, state: state, stage: stage,
                           summary: summary, detail: item["detail"] as? String,
                           action: action)
        }
    }

    // MARK: - Config & assets

    private func applyConfig(_ message: [String: Any]) {
        if let hostPid = message["hostPid"] as? NSNumber, hostPid.int32Value > 0 {
            hostProcessIdentifier = pid_t(hostPid.int32Value)
        }
        if let dir = message["packsDir"] as? String { packsDir = dir }
        if let list = message["pets"] as? [[String: Any]] {
            pets = list.compactMap { item in
                guard let id = item["id"] as? String,
                      let name = item["displayName"] as? String,
                      let version = item["version"] as? Int,
                      let path = item["spritesheetPath"] as? String else { return nil }
                return PetInfo(id: id, displayName: name, version: version, spritesheetPath: path)
            }
        }
        if let id = message["petId"] as? String { petId = id }
        if let size = message["petSize"] as? Int { petSize = size }
        if let quadrant = message["quadrant"] as? String { defaultQuadrant = quadrant }
        if !didRestorePosition {
            if let position = message["position"] as? [String: Any],
               let xNum = position["x"] as? NSNumber,
               let yNum = position["y"] as? NSNumber {
                savedPosition = CGPoint(x: xNum.doubleValue, y: yNum.doubleValue)
                savedPositionMode = message["positionMode"] as? String == "pet-anchor"
                    ? "pet-anchor"
                    : "panel-origin"
            } else {
                savedPosition = nil
                savedPositionMode = "panel-origin"
            }
            // `show()` lays out the default position before config arrives.
            // Discard that provisional anchor so persisted state wins.
            petScreenAnchor = nil
            didRestorePosition = true
        }
        loadSelectedPet()
        applyLayout()
    }

    private func loadSelectedPet() {
        guard !packsDir.isEmpty, !petId.isEmpty,
              let info = pets.first(where: { $0.id == petId }) else { return }
        let dir = (packsDir as NSString).appendingPathComponent(petId)
        let path = (dir as NSString).appendingPathComponent(info.spritesheetPath)
        guard let image = loadImage(at: path) else {
            fputs("desktop-pet: failed to load spritesheet \(path)\n", stderr)
            return
        }
        let layout = atlasForDimensions(width: image.width, height: image.height)
        atlas = layout
        petView.spritesheet = image
        petView.atlas = layout
        applyBaseSequence()
    }

    private func loadImage(at path: String) -> CGImage? {
        let url = URL(fileURLWithPath: path)
        guard let source = CGImageSourceCreateWithURL(url as CFURL, nil) else { return nil }
        return CGImageSourceCreateImageAtIndex(source, 0, nil)
    }

    // MARK: - Layout

    private static func windowSize(for petSize: Int) -> NSSize {
        let width = CGFloat(petSize) + 2 * padding
        let height = CGFloat(petSize) / cellAspect + 2 * padding
        return NSSize(width: width, height: height)
    }

    /// Window size including the task list or status bubble (when present). The
    /// pet stays bottom-anchored; the list/bubble only grows the window upward
    /// so the pet's on-screen position never moves when it appears/disappears.
    private func currentWindowSize() -> NSSize {
        var size = PetController.windowSize(for: petSize)
        if !tasks.isEmpty {
            let listSize = PetView.taskListSize(for: tasks)
            size.width = max(size.width, listSize.width + 2 * PetController.padding)
            size.height += listSize.height + PetView.bubbleGap
        } else if let bubble = bubble {
            let bubbleSize = PetView.bubbleSize(for: bubble)
            size.width = max(size.width, bubbleSize.width + 2 * PetController.padding)
            size.height += bubbleSize.height + PetView.bubbleGap
        }
        return size
    }

    /// Bottom-anchored rect the pet sprite draws into, within `bounds`.
    private func petRect(in bounds: NSRect) -> NSRect {
        let width = CGFloat(petSize)
        let height = CGFloat(petSize) / PetController.cellAspect
        return NSRect(x: bounds.midX - width / 2, y: PetController.padding,
                      width: width, height: height)
    }

    /// Bottom-centre is a stable, sprite-size-independent identity for the
    /// pet's on-screen position.
    private func petAnchor(in rect: NSRect) -> CGPoint {
        CGPoint(x: rect.midX, y: rect.minY)
    }

    private func panelOrigin(forPetAnchor anchor: CGPoint, petRect: NSRect) -> CGPoint {
        let localAnchor = petAnchor(in: petRect)
        return CGPoint(x: anchor.x - localAnchor.x, y: anchor.y - localAnchor.y)
    }

    private func currentPetScreenAnchor() -> CGPoint {
        let localAnchor = petAnchor(in: petView.petRect)
        return CGPoint(x: panel.frame.origin.x + localAnchor.x,
                       y: panel.frame.origin.y + localAnchor.y)
    }

    private func applyLayout() {
        let size = currentWindowSize()
        let proposedBounds = NSRect(origin: .zero, size: size)
        let proposedPetRect = petRect(in: proposedBounds)
        let preservesLiveAnchor = petScreenAnchor != nil
        let proposedOrigin: CGPoint
        if let anchor = petScreenAnchor {
            proposedOrigin = panelOrigin(forPetAnchor: anchor, petRect: proposedPetRect)
        } else if let restored = savedPosition {
            proposedOrigin = savedPositionMode == "pet-anchor"
                ? panelOrigin(forPetAnchor: restored, petRect: proposedPetRect)
                : restored
        } else {
            proposedOrigin = originForQuadrant(defaultQuadrant, size: size)
        }
        // Clamp only the initial/default restore. Clamping every card resize
        // would move the pet, recreating the very jump this layout prevents.
        let origin = preservesLiveAnchor
            ? proposedOrigin
            : clampToVisibleFrame(proposedOrigin, size: size)
        panel.setFrame(NSRect(origin: origin, size: size), display: true)
        let bounds = panel.contentView?.bounds ?? NSRect(origin: .zero, size: size)
        petView.frame = bounds
        petView.petRect = petRect(in: bounds)
        petScreenAnchor = currentPetScreenAnchor()
        petView.needsDisplay = true
    }

    /// Clamp a saved origin back into the screen's visible frame so a restored
    /// position never lands off-screen (e.g. after a resolution change).
    private func clampToVisibleFrame(_ origin: CGPoint, size: NSSize) -> CGPoint {
        // `panel.screen` still points at the provisional launch screen until
        // the restored frame is applied. Select the screen from the persisted
        // pet anchor instead, otherwise a pet saved on a secondary display is
        // incorrectly clamped back onto the main display after every restart.
        let anchor = CGPoint(
            x: origin.x + size.width / 2,
            y: origin.y + PetController.padding
        )
        let proposedFrame = NSRect(origin: origin, size: size)
        let containingScreen = NSScreen.screens.first { $0.frame.contains(anchor) }
        let overlappingScreen = NSScreen.screens
            .map { screen -> (screen: NSScreen, area: CGFloat) in
                let intersection = screen.frame.intersection(proposedFrame)
                let area = intersection.isNull ? 0 : intersection.width * intersection.height
                return (screen, area)
            }
            .max { $0.area < $1.area }
        let overlapTarget = overlappingScreen.flatMap { candidate in
            candidate.area > 0 ? candidate.screen : nil
        }
        guard let screen = containingScreen
                ?? overlapTarget
                ?? panel.screen
                ?? NSScreen.main else { return origin }
        let visible = screen.visibleFrame
        let x = min(max(origin.x, visible.minX), visible.maxX - size.width)
        let y = min(max(origin.y, visible.minY), visible.maxY - size.height)
        return CGPoint(x: x, y: y)
    }

    private func originForQuadrant(_ quadrant: String, size: NSSize) -> CGPoint {
        guard let screen = panel.screen ?? NSScreen.main else { return .zero }
        let visible = screen.visibleFrame
        let margin: CGFloat = 8
        let horizontal = quadrant.hasSuffix("-start") ? "start" : "end"
        let vertical = quadrant.hasPrefix("top-") ? "top" : "bottom"
        let x = horizontal == "start" ? visible.minX + margin : visible.maxX - size.width - margin
        let y = vertical == "bottom" ? visible.minY + margin : visible.maxY - size.height - margin
        return CGPoint(x: x, y: y)
    }

    // MARK: - Animation

    private func startTimer() {
        timer?.invalidate()
        let t = Timer(timeInterval: 1.0 / 60.0, repeats: true) { [weak self] _ in self?.tick() }
        RunLoop.main.add(t, forMode: .common)
        timer = t
    }

    private func tick() {
        if let until = wavingUntil, Date() >= until {
            wavingUntil = nil
            applyBaseSequence()
        }
        guard !sequence.frames.isEmpty else { return }
        let current = sequence.frames[frameIndex]
        elapsedMs += 1000.0 / 60.0
        if elapsedMs >= Double(current.frameDurationMs) {
            elapsedMs = 0
            advance()
        }
        let frame = currentFrame()
        if petView.currentFrame.columnIndex != frame.columnIndex || petView.currentFrame.rowIndex != frame.rowIndex {
            petView.currentFrame = frame
        }
    }

    private func advance() {
        let next = frameIndex + 1
        if next < sequence.frames.count {
            frameIndex = next
        } else if let loop = sequence.loopStartIndex {
            frameIndex = loop
        }
    }

    private func currentFrame() -> FrameRef {
        if dragging {
            return sequence.frames.isEmpty
                ? FrameRef(columnIndex: 0, rowIndex: 0, frameDurationMs: 0)
                : sequence.frames[frameIndex]
        }
        // A click-triggered wave is explicit user feedback and takes priority
        // over passive cursor-following while the pointer remains on the pet.
        if wavingUntil == nil, hoverActive, let look = lookFrameRef {
            return look
        }
        if sequence.frames.isEmpty {
            return FrameRef(columnIndex: 0, rowIndex: 0, frameDurationMs: 0)
        }
        return sequence.frames[frameIndex]
    }

    private func setSequence(_ state: PetState) {
        sequence = sequenceFor(state)
        frameIndex = 0
        elapsedMs = 0
    }

    /// Play the base-state animation (in place; no locomotion).
    private func applyBaseSequence() {
        setSequence(baseState)
    }

    // MARK: - Mouse

    private func installTrackingArea() {
        let area = NSTrackingArea(
            rect: .zero,
            options: [.mouseEnteredAndExited, .mouseMoved, .activeAlways, .inVisibleRect],
            owner: petView,
            userInfo: nil
        )
        petView.addTrackingArea(area)
    }

    private func mouseEntered() {
        hoverActive = true
        cursorWindow = panel.convertPoint(fromScreen: NSEvent.mouseLocation)
        if !(atlas?.version == 2 && lookEnabledStates.contains(baseState)) {
            setSequence(.jumping)
        }
        updateLook()
    }

    private func mouseMoved(_ locationInWindow: CGPoint) {
        cursorWindow = locationInWindow
        updateLook()
    }

    private func mouseExited() {
        hoverActive = false
        lookFrameRef = nil
        if wavingUntil == nil {
            applyBaseSequence()
        }
    }

    private func updateLook() {
        guard atlas?.version == 2, lookEnabledStates.contains(baseState) else {
            lookFrameRef = nil
            return
        }
        lookFrameRef = lookFrame(rect: petView.petRect, cursor: cursorWindow, version: 2)
    }

    private func mouseDowned(_ global: CGPoint) {
        mouseDownGlobal = global
        dragOrigin = panel.frame.origin
        dragged = false
        dragging = false
        dragState = .idle
    }

    private func mouseDraggedTo(_ global: CGPoint) {
        let dx = global.x - mouseDownGlobal.x
        let dy = global.y - mouseDownGlobal.y
        if hypot(dx, dy) >= PetController.dragActivationDistance { dragged = true }
        if dragged {
            dragging = true
            panel.setFrameOrigin(CGPoint(x: dragOrigin.x + dx, y: dragOrigin.y + dy))
            // Locomotion while dragging: play the direction-matching run cycle
            // (running-left row 2 / running-right row 1), only restarting when
            // the direction flips so the sequence keeps advancing.
            let nextState: PetState = dx < 0 ? .runningLeft : .runningRight
            if nextState != dragState {
                dragState = nextState
                setSequence(nextState)
            }
        }
    }

    private func mouseUpped() {
        if !dragged {
            playWave()
            focusHostApplication()
            return
        }
        dragging = false
        reportCurrentPosition()
        dragged = false
        dragState = .idle
        applyBaseSequence()
    }

    /// Persist the pet's stable screen-space anchor. This is called both when
    /// a drag finishes and during the graceful shutdown handshake.
    private func reportCurrentPosition() {
        let anchor = currentPetScreenAnchor()
        petScreenAnchor = anchor
        savedPosition = anchor
        savedPositionMode = "pet-anchor"
        protocolIO.send(kind: "move", payload: [
            "position": ["x": anchor.x, "y": anchor.y],
            "positionMode": "pet-anchor",
        ])
    }

    private func playWave() {
        wavingUntil = Date().addingTimeInterval(2.1) // tripled waving duration
        lookFrameRef = nil
        setSequence(.waving)
    }

    /// Return keyboard focus to the exact Harness instance that launched the
    /// plugin. This does not navigate, so an ordinary pet click preserves the
    /// current conversation; task-row navigation remains the host's job.
    private func focusHostApplication() {
        guard let pid = hostProcessIdentifier,
              let application = NSRunningApplication(processIdentifier: pid) else { return }
        if #available(macOS 14.0, *) {
            application.activate(options: [.activateAllWindows])
        } else {
            application.activate(options: [.activateAllWindows, .activateIgnoringOtherApps])
        }
    }

    // MARK: - Menu

    private func showMenu(_ event: NSEvent) {
        let menu = NSMenu()
        let hideItem = NSMenuItem(title: "隐藏宠物", action: #selector(hidePet(_:)), keyEquivalent: "")
        hideItem.target = self
        menu.addItem(hideItem)
        NSMenu.popUpContextMenu(menu, with: event, for: petView)
    }

    /// Hide the panel immediately, then tell the plugin to persist `enabled:
    /// false` so the pet stays hidden until re-enabled from the settings card.
    @objc private func hidePet(_ sender: NSMenuItem) {
        panel.orderOut(nil)
        protocolIO.send(kind: "hide")
    }
}
