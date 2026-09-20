import AppKit
import WebKit

@main enum FirstClickChecks {
  @MainActor static func main() {
    let application = NSApplication.shared
    application.setActivationPolicy(.accessory)
    let controller = MainWindowController(websiteDataStore: .nonPersistent())
    guard let window = controller.window,
          let webView = window.contentView?.subviews.compactMap({ $0 as? WKWebView }).first,
          let click = NSEvent.mouseEvent(
            with: .leftMouseDown, location: NSPoint(x: 40, y: 40),
            modifierFlags: [], timestamp: ProcessInfo.processInfo.systemUptime,
            windowNumber: window.windowNumber, context: nil,
            eventNumber: 1, clickCount: 1, pressure: 1
          ) else { fatalError("Missing window, page view or mouse event") }
    precondition(!window.isKeyWindow)
    precondition(!webView.configuration.websiteDataStore.isPersistent)
    // Query the installed view, so replacing it with a plain WKWebView fails.
    precondition(webView.acceptsFirstMouse(for: click))
    precondition(webView.acceptsFirstMouse(for: nil))
    print("Window WebView accepts the activating click")
  }
}
