import Darwin
import Foundation

/// The Host lifecycle the application shell drives. Injecting it lets the
/// reopen and shutdown policy be exercised without launching a real Host.
protocol HostLifecycle: AnyObject {
  var onStateChange: ((ServerController.State) -> Void)? { get set }
  func restart()
  func ensureRunning()
  func stop()
}

final class ServerController: HostLifecycle {
  enum State {
    case restarting
    case starting
    case ready(URL)
    case failed(String)
  }

  var onStateChange: ((State) -> Void)?

  private let servicePort = Bundle.main.object(forInfoDictionaryKey: "DSHServicePort") as? Int ?? 3080
  private lazy var serviceURL = URL(string: "http://127.0.0.1:\(servicePort)")!
  private var process: Process?
  private var logHandle: FileHandle?
  private var outputPipe: Pipe?
  private var outputGeneration = UUID()
  private var hostOutput: HostOutput?
  private var readinessTimer: Timer?
  private var recoveryTimer: Timer?
  private var recovery = HostRecovery()
  private var hostWasReady = false
  private var probeInFlight = false
  private var restartInFlight = false
  private var stopping = false
  private var paths: RuntimePaths {
    let managedRoot = (Bundle.main.object(forInfoDictionaryKey: "DSHInstallationRoot") as? String)
      .map { URL(fileURLWithPath: $0, isDirectory: true) }
    let dshHome = (Bundle.main.object(forInfoDictionaryKey: "DSHHome") as? String)
      .map { URL(fileURLWithPath: $0, isDirectory: true) }
    return RuntimePaths(managedRoot: managedRoot, userHome: FileManager.default.homeDirectoryForCurrentUser, configuredDshHome: dshHome)
  }

  func restart() {
    guard !restartInFlight else { return }
    recoveryTimer?.invalidate()
    recoveryTimer = nil
    recovery = HostRecovery()
    guard (1...65535).contains(servicePort) else {
      onStateChange?(.failed("DSHServicePort must be between 1 and 65535."))
      return
    }
    restartInFlight = true
    stopping = false
    readinessTimer?.invalidate()
    onStateChange?(.restarting)

    let managedProcess = process
    process = nil

    DispatchQueue.global(qos: .userInitiated).async { [weak self] in
      guard let self else { return }
      do {
        if let managedProcess {
          try self.stopProcess(managedProcess.processIdentifier)
          self.clearRecordedPID(managedProcess.processIdentifier)
        }
        try self.stopRecordedServer()
        try self.stopExistingServer()
        DispatchQueue.main.async {
          self.restartInFlight = false
          guard !self.stopping else { return }
          self.startServer()
        }
      } catch {
        DispatchQueue.main.async {
          self.restartInFlight = false
          self.onStateChange?(.failed(error.localizedDescription))
        }
      }
    }
  }

  /// Start the Host only when this app is not already running one. A restart
  /// would terminate the Node process along with every agent inside it, which
  /// is never what merely reactivating the window asks for.
  func ensureRunning() {
    guard !restartInFlight else { return }
    if let managedProcess = process, processExists(managedProcess.processIdentifier) { return }
    restart()
  }

  func stop() {
    stopping = true
    readinessTimer?.invalidate()
    recoveryTimer?.invalidate()
    recoveryTimer = nil
    if let managedProcess = process {
      do {
        try stopProcess(managedProcess.processIdentifier)
        clearRecordedPID(managedProcess.processIdentifier)
      } catch {
        NSLog("DeepSeek Harness Host shutdown failed: %@", error.localizedDescription)
      }
    }
    process = nil
    outputPipe?.fileHandleForReading.readabilityHandler = nil
    outputPipe = nil
    try? logHandle?.close()
  }

  private func startServer() {
    do {
      for name in [".bootstrap.lock", ".update-transaction.json"] {
        if FileManager.default.fileExists(atPath: paths.support.appendingPathComponent(name).path) {
          throw NSError(domain: "DSHInstaller", code: 1, userInfo: [NSLocalizedDescriptionKey: "Installation is updating. Finish make init before starting DSH."])
        }
      }
      for name in [".dhp-install.lock", ".dhp-profile-update.json"] {
        if FileManager.default.fileExists(atPath: paths.dshHome.appendingPathComponent(name).path) {
          throw NSError(domain: "DSHInstaller", code: 1, userInfo: [NSLocalizedDescriptionKey: "DSH home is updating. Finish make init before starting DSH."])
        }
      }
      let launch = try launchConfiguration()
      let workspace = try prepareWorkspace()
      let appSupport = try prepareApplicationSupport()
      let child = Process()
      child.executableURL = launch.node
      child.arguments = launch.arguments + [
        "--profile", "web",
        "--patch", try bundledResource("launcher/native-lifecycle.patch.yml").path,
        "--host", "127.0.0.1", "--port", String(servicePort), "--no-open",
      ]
      child.currentDirectoryURL = workspace
      child.environment = childEnvironment(node: launch.node, appSupport: appSupport)
      try prepareLog()
      outputPipe?.fileHandleForReading.readabilityHandler = nil
      let output = Pipe(), generation = UUID()
      outputPipe = output
      outputGeneration = generation
      hostOutput = HostOutput(port: servicePort)
      hostWasReady = false
      output.fileHandleForReading.readabilityHandler = { [weak self] handle in
        let bytes = handle.availableData
        if bytes.isEmpty { handle.readabilityHandler = nil }
        DispatchQueue.main.async {
          guard let self, self.outputGeneration == generation else { return }
          if let text = self.hostOutput?.consume(bytes, end: bytes.isEmpty), !text.isEmpty {
            try? self.logHandle?.write(contentsOf: Data(text.utf8))
          }
        }
      }
      child.standardOutput = output
      child.standardError = output
      child.terminationHandler = { [weak self] terminated in
        DispatchQueue.main.async {
          self?.clearRecordedPID(terminated.processIdentifier)
          guard let self, !self.stopping, self.process === terminated else { return }
          self.readinessTimer?.invalidate()
          self.process = nil
          self.handleUnexpectedExit(terminated)
        }
      }
      try child.run()
      process = child
      do {
        try recordPID(child.processIdentifier, appSupport: appSupport)
      } catch {
        try? stopProcess(child.processIdentifier)
        process = nil
        throw error
      }
      onStateChange?(.starting)
      lifecycleLog("Host started pid=\(child.processIdentifier)")
      waitUntilReady(child: child)
    } catch {
      lifecycleLog("Host startup failed: \(error.localizedDescription)")
      onStateChange?(.failed(error.localizedDescription))
    }
  }

  private func lifecycleLog(_ message: String) {
    let line = "[native \(ISO8601DateFormatter().string(from: Date()))] \(message)\n"
    try? logHandle?.write(contentsOf: Data(line.utf8))
  }

  private func handleUnexpectedExit(_ child: Process) {
    let detail = "The server exited with status \(child.terminationStatus)."
    lifecycleLog("Host exited pid=\(child.processIdentifier) status=\(child.terminationStatus) reason=\(child.terminationReason.rawValue) ready=\(hostWasReady)")
    guard let delay = recovery.delayAfterExit(wasReady: hostWasReady, now: ProcessInfo.processInfo.systemUptime) else {
      let reason = hostWasReady ? "Automatic recovery stopped after repeated exits." : "The server exited before becoming ready."
      lifecycleLog(reason)
      onStateChange?(.failed("\(detail) \(reason) See \(paths.log.path)."))
      return
    }
    lifecycleLog("Automatic Host recovery scheduled in \(Int(delay))s")
    onStateChange?(.restarting)
    recoveryTimer = Timer.scheduledTimer(withTimeInterval: delay, repeats: false) { [weak self] timer in
      guard let self, self.recoveryTimer === timer else { return }
      self.recoveryTimer = nil
      guard !self.stopping, !self.restartInFlight, self.process == nil else { return }
      do {
        // A different owner may claim the port while recovery is delayed.
        try self.stopExistingServer()
        self.startServer()
      } catch {
        self.lifecycleLog("Automatic Host recovery failed: \(error.localizedDescription)")
        self.onStateChange?(.failed(error.localizedDescription))
      }
    }
  }

  private func bundledResource(_ relativePath: String) throws -> URL {
    guard let root = Bundle.main.resourceURL else {
      throw LauncherError.missingResource(relativePath)
    }
    let resource = root.appendingPathComponent(relativePath)
    guard FileManager.default.fileExists(atPath: resource.path) else {
      throw LauncherError.missingResource(relativePath)
    }
    return resource
  }

  private func launchConfiguration() throws -> LaunchConfiguration {
    return LaunchConfiguration(
      node: try bundledResource("node/bin/node"),
      arguments: [try bundledResource(
        "runtime/node_modules/@deepseek-ai/dsh/lib/bin.js"
      ).path]
    )
  }

  private func prepareWorkspace() throws -> URL {
    let workspace = paths.workspace
    try FileManager.default.createDirectory(
      at: workspace,
      withIntermediateDirectories: true
    )
    return workspace
  }

  private func prepareApplicationSupport() throws -> URL {
    let appSupport = paths.support
    try FileManager.default.createDirectory(
      at: appSupport,
      withIntermediateDirectories: true
    )
    return appSupport
  }

  private func pidFile(in appSupport: URL? = nil) -> URL {
    let root = appSupport ?? paths.support
    return root.appendingPathComponent("host.pid")
  }

  private func recordPID(_ pid: Int32, appSupport: URL) throws {
    try Data("\(pid)\n".utf8).write(to: pidFile(in: appSupport), options: .atomic)
  }

  private func recordedPID() -> Int32? {
    guard let bytes = try? Data(contentsOf: pidFile()),
          let text = String(data: bytes, encoding: .utf8) else { return nil }
    return Int32(text.trimmingCharacters(in: .whitespacesAndNewlines))
  }

  private func clearRecordedPID(_ expectedPID: Int32) {
    guard recordedPID() == expectedPID else { return }
    try? FileManager.default.removeItem(at: pidFile())
  }

  private func prepareLog() throws {
    try? logHandle?.close()
    let log = paths.log
    try FileManager.default.createDirectory(
      at: log.deletingLastPathComponent(),
      withIntermediateDirectories: true
    )
    if !FileManager.default.fileExists(atPath: log.path) {
      FileManager.default.createFile(atPath: log.path, contents: nil, attributes: [.posixPermissions: 0o600])
    }
    let handle = try FileHandle(forWritingTo: log)
    try handle.seekToEnd()
    logHandle = handle
  }

  private func childEnvironment(node: URL, appSupport: URL) -> [String: String] {
    var environment = ProcessInfo.processInfo.environment
    environment["PATH"] = [
      node.deletingLastPathComponent().path,
      Bundle.main.resourceURL?.appendingPathComponent("runtime/node_modules/.bin").path ?? "",
      "/opt/homebrew/bin",
      "/usr/local/bin",
      "/usr/bin",
      "/bin",
      "/usr/sbin",
      "/sbin",
    ].joined(separator: ":")
    environment.removeValue(forKey: "NODE_OPTIONS")
    environment.removeValue(forKey: "NODE_PATH")
    environment["DSH_HOME"] = paths.dshHome.path
    environment["DSH_AGENTS_HOME"] = paths.agentsHome.path
    environment["DSH_NATIVE_APP"] = "1"
    return environment
  }

  private func waitUntilReady(child: Process) {
    var attemptsRemaining = 120
    readinessTimer = Timer.scheduledTimer(withTimeInterval: 0.5, repeats: true) {
      [weak self] timer in
      guard let self, self.process === child, child.isRunning, !self.stopping else {
        timer.invalidate()
        return
      }
      attemptsRemaining -= 1
      if attemptsRemaining == 0 {
        timer.invalidate()
        self.onStateChange?(.failed(
          "The server did not become ready within 60 seconds. "
            + "See \(self.paths.log.path)."
        ))
        return
      }
      self.probeService { ready in
        guard ready, timer.isValid, self.process === child, child.isRunning, !self.stopping else { return }
        timer.invalidate()
        guard let url = self.hostOutput?.authenticatedURL else { return }
        self.hostWasReady = true
        self.lifecycleLog("Host ready pid=\(child.processIdentifier)")
        self.onStateChange?(.ready(url))
      }
    }
  }

  private func probeService(completion: @escaping (Bool) -> Void) {
    guard !probeInFlight, let url = hostOutput?.authenticatedURL else { return }
    probeInFlight = true
    var request = URLRequest(url: url)
    request.timeoutInterval = 0.4
    URLSession.shared.dataTask(with: request) { [weak self] _, response, _ in
      let status = (response as? HTTPURLResponse)?.statusCode
      let ready = status.map { (200..<300).contains($0) } ?? false
      DispatchQueue.main.async {
        self?.probeInFlight = false
        completion(ready)
      }
    }.resume()
  }

  private func commandOutput(
    _ executable: String,
    arguments: [String]
  ) throws -> (status: Int32, text: String) {
    let command = Process()
    let output = Pipe()
    command.executableURL = URL(fileURLWithPath: executable)
    command.arguments = arguments
    command.standardOutput = output
    command.standardError = FileHandle.nullDevice
    try command.run()
    let bytes = output.fileHandleForReading.readDataToEndOfFile()
    command.waitUntilExit()
    return (command.terminationStatus, String(decoding: bytes, as: UTF8.self))
  }

  private func listenerPIDs() throws -> [Int32] {
    let output = try commandOutput(
      "/usr/sbin/lsof",
      arguments: ["-nP", "-tiTCP:\(servicePort)", "-sTCP:LISTEN"]
    )
    if output.status == 1 { return [] }
    guard output.status == 0 else {
      throw LauncherError.listenerInspectionFailed(servicePort, output.status)
    }
    return output.text.split(whereSeparator: \.isNewline).compactMap { Int32($0) }
  }

  private func commandLine(for pid: Int32) throws -> String? {
    let output = try commandOutput(
      "/bin/ps",
      arguments: ["-p", String(pid), "-o", "command="]
    )
    guard output.status == 0 else { return nil }
    return output.text.trimmingCharacters(in: .whitespacesAndNewlines)
  }

  private func isNativeDshWebServer(_ command: String) -> Bool {
    guard let root = Bundle.main.resourceURL else { return false }
    return command.contains(root.appendingPathComponent("runtime/node_modules/@deepseek-ai/dsh/lib/bin.js").path + " web")
  }

  private func processExists(_ pid: Int32) -> Bool {
    if Darwin.kill(pid, 0) == 0 { return true }
    return errno != ESRCH
  }

  private func waitForProcessExit(_ pid: Int32, attempts: Int) -> Bool {
    for _ in 0..<attempts {
      if !processExists(pid) { return true }
      Thread.sleep(forTimeInterval: 0.1)
    }
    return !processExists(pid)
  }

  private func stopProcess(_ pid: Int32) throws {
    if Darwin.kill(pid, SIGTERM) != 0 && errno != ESRCH {
      throw LauncherError.cannotStop(pid)
    }
    if waitForProcessExit(pid, attempts: 50) { return }
    if Darwin.kill(pid, SIGKILL) != 0 && errno != ESRCH {
      throw LauncherError.cannotStop(pid)
    }
    guard waitForProcessExit(pid, attempts: 20) else {
      throw LauncherError.processStopTimedOut(pid)
    }
  }

  private func stopRecordedServer() throws {
    guard let pid = recordedPID() else { return }
    guard let command = try commandLine(for: pid), isNativeDshWebServer(command) else {
      clearRecordedPID(pid)
      return
    }
    try stopProcess(pid)
    clearRecordedPID(pid)
  }

  private func stopExistingServer() throws {
    for pid in try listenerPIDs() {
      guard let command = try commandLine(for: pid) else { continue }
      throw LauncherError.portInUse(servicePort, String(command.prefix(300)))
    }
  }
}

private enum LauncherError: LocalizedError {
  case missingResource(String)
  case listenerInspectionFailed(Int, Int32)
  case portInUse(Int, String)
  case cannotStop(Int32)
  case processStopTimedOut(Int32)

  var errorDescription: String? {
    switch self {
    case .missingResource(let path):
      "The application bundle is incomplete: missing \(path)."
    case .listenerInspectionFailed(let port, let status):
      "Cannot inspect port \(port); lsof exited with status \(status)."
    case .portInUse(let port, let command):
      "Port \(port) is used by another process, which was left running: \(command)"
    case .cannotStop(let pid):
      "Cannot stop the existing DeepSeek Harness process \(pid)."
    case .processStopTimedOut(let pid):
      "The existing DeepSeek Harness process \(pid) did not exit."
    }
  }
}

private struct LaunchConfiguration {
  let node: URL
  let arguments: [String]
}
