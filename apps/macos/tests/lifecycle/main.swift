import AppKit

final class HostSpy: HostLifecycle {
  var onStateChange: ((ServerController.State) -> Void)?
  private(set) var restarts = 0
  private(set) var ensureRunningCalls = 0

  func restart() { restarts += 1 }
  func ensureRunning() { ensureRunningCalls += 1 }
  func stop() {}
}

@main enum LifecycleChecks {
  @MainActor static func main() {
    let application = NSApplication.shared
    application.setActivationPolicy(.accessory)
    let host = HostSpy()
    let delegate = AppDelegate(server: host)
    application.delegate = delegate

    precondition(delegate.applicationShouldHandleReopen(application, hasVisibleWindows: false))
    precondition(host.restarts == 0)
    precondition(host.ensureRunningCalls == 1)

    precondition(delegate.applicationShouldHandleReopen(application, hasVisibleWindows: true))
    precondition(host.restarts == 0)
    precondition(host.ensureRunningCalls == 2)

    func waitFor(_ condition: () -> Bool) {
      let deadline = Date().addingTimeInterval(5)
      while !condition() && Date() < deadline {
        RunLoop.main.run(until: Date().addingTimeInterval(0.05))
      }
      precondition(condition(), "Native restart notification must be delivered")
    }
    let otherApp = URL(fileURLWithPath: "/tmp/another-dsh-\(UUID().uuidString).app")
    var otherReceived = false
    let otherObserver = HostRestartRequest.observe(app: otherApp) { otherReceived = true }
    HostRestartRequest.send(app: otherApp)
    waitFor { otherReceived }
    HostRestartRequest.remove(otherObserver)
    precondition(host.restarts == 0, "A different installation must not restart this Host")

    HostRestartRequest.send(app: Bundle.main.bundleURL)
    waitFor { host.restarts > 0 }
    precondition(host.restarts == 1, "Explicit restart must reach the native Host owner")
    print("Reopen preserves the Host; explicit restart targets its installation")
  }
}
