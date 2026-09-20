import Foundation

/// A restart request targets one installed App, independently of Dock activation.
enum HostRestartRequest {
  static let name = Notification.Name("com.shamcleren.dsh.restart-host")

  static func observe(app: URL, handler: @escaping () -> Void) -> NSObjectProtocol {
    DistributedNotificationCenter.default().addObserver(
      forName: name, object: app.resolvingSymlinksInPath().path, queue: .main
    ) { _ in handler() }
  }

  static func send(app: URL) {
    DistributedNotificationCenter.default().postNotificationName(
      name, object: app.resolvingSymlinksInPath().path, userInfo: nil, deliverImmediately: true
    )
  }

  static func remove(_ observer: NSObjectProtocol) {
    DistributedNotificationCenter.default().removeObserver(observer)
  }
}
