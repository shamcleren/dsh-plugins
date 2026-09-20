import AppKit

final class AppDelegate: NSObject, NSApplicationDelegate, ApplicationQuitTarget {
  private let server: HostLifecycle
  private let windowController = MainWindowController()
  private var quitRequested = false
  private var restartObserver: NSObjectProtocol?

  init(server: HostLifecycle = ServerController()) {
    self.server = server
    super.init()
    restartObserver = HostRestartRequest.observe(app: Bundle.main.bundleURL) { [weak self] in
      self?.server.restart()
    }
  }

  deinit {
    if let observer = restartObserver { HostRestartRequest.remove(observer) }
  }

  func applicationDidFinishLaunching(_ notification: Notification) {
    MainMenu.install(for: NSApp, quitTarget: self)
    server.onStateChange = { [weak self] state in
      self?.render(state)
    }
    windowController.onRestartHost = { [weak self] in
      self?.server.restart()
    }
    windowController.showWindow(nil)
    NSApp.activate(ignoringOtherApps: true)
    server.restart()
  }

  func applicationShouldHandleReopen(
    _ sender: NSApplication,
    hasVisibleWindows flag: Bool
  ) -> Bool {
    windowController.showWindow(nil)
    NSApp.activate(ignoringOtherApps: true)
    // AppKit sends this for every Dock activation, including one that only
    // deminiaturizes the window, so the Host is left alone unless it is gone.
    server.ensureRunning()
    return true
  }

  func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool {
    false
  }

  func applicationWillTerminate(_ notification: Notification) {
    if let observer = restartObserver { HostRestartRequest.remove(observer) }
    restartObserver = nil
    server.stop()
  }

  func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
    guard windowController.hasPendingDownloads else { return .terminateNow }
    windowController.stopDownloads { sender.reply(toApplicationShouldTerminate: true) }
    return .terminateLater
  }

  @objc func quitApplication(_ sender: Any?) {
    guard !quitRequested else { return }
    quitRequested = true
    // Dismiss an owned Save panel before asking AppKit to terminate; a modal panel can consume the standard Quit action.
    windowController.stopDownloads { [weak self] in
      self?.quitRequested = false
      NSApp.terminate(sender)
    }
  }

  private func render(_ state: ServerController.State) {
    switch state {
    case .restarting:
      windowController.showStatus("Restarting DeepSeek Harness…", isError: false)
    case .starting:
      windowController.showStatus("Starting DeepSeek Harness…", isError: false)
    case .ready(let url):
      windowController.load(url)
    case .failed(let message):
      NSLog("DeepSeek Harness startup failed: %@", message)
      windowController.showStatus(message, isError: true)
    }
  }
}
