import AppKit
import WebKit

final class HarnessWebView: WKWebView {
  // Deliver the activating click to the page instead of spending it only on
  // window focus, which otherwise makes menus appear to need two clicks.
  override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }
}

final class MainWindowController: NSWindowController, WKUIDelegate, WKNavigationDelegate, WKScriptMessageHandler, NSWindowDelegate {
  var onRestartHost: (() -> Void)?

  private let webView: WKWebView
  private var serviceURL: URL?
  private let statusView = NSVisualEffectView()
  private let statusLabel = NSTextField(labelWithString: "")
  private let progress = NSProgressIndicator()
  private var downloads: WebDownloads?
  private let shareBridge = ShareBridge()
  private let openExternal: (URL) -> Void

  init(websiteDataStore: WKWebsiteDataStore = .default(), openExternal: @escaping (URL) -> Void = { NSWorkspace.shared.open($0) }) {
    self.openExternal = openExternal
    let configuration = WKWebViewConfiguration()
    configuration.websiteDataStore = websiteDataStore
    NativeTextInputPreferences.install(in: configuration.userContentController)
    webView = HarnessWebView(frame: .zero, configuration: configuration)

    let window = NSWindow(
      contentRect: NSRect(x: 0, y: 0, width: 1280, height: 800),
      styleMask: [.titled, .closable, .miniaturizable, .resizable],
      backing: .buffered,
      defer: false
    )
    window.title = "DeepSeek Harness"
    window.minSize = NSSize(width: 900, height: 600)
    window.center()
    super.init(window: window)
    downloads = WebDownloads(window: window)
    window.delegate = self
    webView.configuration.userContentController.add(
      self,
      contentWorld: .page,
      name: "dshNative"
    )
    if shareBridge.available { webView.configuration.userContentController.addScriptMessageHandler(shareBridge, contentWorld: .page, name: "dshShare") }
    configureContent(in: window)
  }

  @available(*, unavailable)
  required init?(coder: NSCoder) {
    fatalError("init(coder:) is unavailable")
  }

  deinit {
    webView.configuration.userContentController.removeScriptMessageHandler(forName: "dshShare", contentWorld: .page)
    webView.configuration.userContentController.removeScriptMessageHandler(
      forName: "dshNative",
      contentWorld: .page
    )
  }

  func userContentController(
    _ userContentController: WKUserContentController,
    didReceive message: WKScriptMessage
  ) {
    guard message.name == "dshNative" else { return }
    let origin = message.frameInfo.securityOrigin
    guard NativeBridgePolicy.allows(scheme: origin.protocol, host: origin.host, port: origin.port, serviceURL: serviceURL) else {
      return
    }
    guard let body = message.body as? [String: Any],
          let action = body["action"] as? String else { return }
    if action == "restartHost" {
      onRestartHost?()
      return
    }
    guard action == "openExternal",
          let rawURL = body["url"] as? String,
          let url = URL(string: rawURL),
          url.scheme == "https",
          url.host == "gitlab.example.com",
          url.path == "/oauth/authorize" else { return }
    openExternal(url)
  }

  func showStatus(_ message: String, isError: Bool) {
    statusLabel.stringValue = message
    statusLabel.textColor = isError ? .systemRed : .labelColor
    if isError {
      progress.stopAnimation(nil)
    } else {
      progress.startAnimation(nil)
    }
    statusView.isHidden = false
    webView.isHidden = true
  }

  func load(_ url: URL) {
    serviceURL = url
    shareBridge.serviceURL = url
    statusView.isHidden = true
    webView.isHidden = false
    webView.load(URLRequest(url: url))
  }

  func windowWillClose(_ notification: Notification) { downloads?.stop() }

  override func showWindow(_ sender: Any?) {
    downloads?.resume()
    super.showWindow(sender)
  }

  func stopDownloads(completion: @escaping () -> Void) {
    if let downloads { downloads.stop(completion: completion) }
    else { DispatchQueue.main.async(execute: completion) }
  }

  var hasPendingDownloads: Bool { downloads?.hasPendingWork ?? false }

  func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
    if navigationAction.shouldPerformDownload {
      let origin = navigationAction.sourceFrame.securityOrigin
      let trusted = NativeBridgePolicy.allows(scheme: origin.protocol, host: origin.host, port: origin.port, serviceURL: serviceURL)
      decisionHandler(trusted && DownloadPolicy.allows(navigationAction.request.url, serviceURL: serviceURL) ? .download : .cancel)
      return
    }
    // Subframes may embed content, but only the Host may occupy the app window.
    guard navigationAction.targetFrame == nil || navigationAction.targetFrame?.isMainFrame == true else {
      decisionHandler(.allow)
      return
    }
    let destination = WindowNavigationPolicy.destination(navigationAction.request.url, serviceURL: serviceURL)
    decisionHandler(destination == .internalPage ? .allow : .cancel)
    if destination == .externalPage, let url = navigationAction.request.url { openExternal(url) }
  }

  func webView(_ webView: WKWebView, decidePolicyFor navigationResponse: WKNavigationResponse, decisionHandler: @escaping (WKNavigationResponsePolicy) -> Void) {
    if !navigationResponse.canShowMIMEType {
      decisionHandler(DownloadPolicy.allows(navigationResponse.response.url, serviceURL: serviceURL) ? .download : .cancel)
      return
    }
    // Server redirects can change origin after the navigation action was allowed.
    if navigationResponse.isForMainFrame {
      let destination = WindowNavigationPolicy.destination(navigationResponse.response.url, serviceURL: serviceURL)
      if destination != .internalPage {
        decisionHandler(.cancel)
        if destination == .externalPage, let url = navigationResponse.response.url { openExternal(url) }
        return
      }
    }
    decisionHandler(.allow)
  }

  func webView(_ webView: WKWebView, navigationAction: WKNavigationAction, didBecome download: WKDownload) { downloads?.accept(download, origin: serviceURL) }
  func webView(_ webView: WKWebView, navigationResponse: WKNavigationResponse, didBecome download: WKDownload) { downloads?.accept(download, origin: serviceURL) }

  func webView(
    _ webView: WKWebView,
    createWebViewWith configuration: WKWebViewConfiguration,
    for navigationAction: WKNavigationAction,
    windowFeatures: WKWindowFeatures
  ) -> WKWebView? {
    guard navigationAction.targetFrame == nil else { return nil }
    // window.open can reach the UI delegate without an action-policy callback.
    switch WindowNavigationPolicy.destination(navigationAction.request.url, serviceURL: serviceURL) {
    case .internalPage:
      webView.load(navigationAction.request)
    case .externalPage:
      if let url = navigationAction.request.url { openExternal(url) }
    case .blocked:
      break
    }
    return nil
  }

  private func configureContent(in window: NSWindow) {
    let content = NSView()
    window.contentView = content
    webView.uiDelegate = self
    webView.navigationDelegate = self
    webView.translatesAutoresizingMaskIntoConstraints = false
    content.addSubview(webView)

    statusView.material = .underWindowBackground
    statusView.blendingMode = .withinWindow
    statusView.translatesAutoresizingMaskIntoConstraints = false
    content.addSubview(statusView)

    progress.style = .spinning
    progress.controlSize = .large
    progress.translatesAutoresizingMaskIntoConstraints = false
    statusLabel.alignment = .center
    statusLabel.font = .systemFont(ofSize: 15, weight: .medium)
    statusLabel.maximumNumberOfLines = 4
    statusLabel.translatesAutoresizingMaskIntoConstraints = false
    statusView.addSubview(progress)
    statusView.addSubview(statusLabel)

    NSLayoutConstraint.activate([
      webView.leadingAnchor.constraint(equalTo: content.leadingAnchor),
      webView.trailingAnchor.constraint(equalTo: content.trailingAnchor),
      webView.topAnchor.constraint(equalTo: content.topAnchor),
      webView.bottomAnchor.constraint(equalTo: content.bottomAnchor),
      statusView.leadingAnchor.constraint(equalTo: content.leadingAnchor),
      statusView.trailingAnchor.constraint(equalTo: content.trailingAnchor),
      statusView.topAnchor.constraint(equalTo: content.topAnchor),
      statusView.bottomAnchor.constraint(equalTo: content.bottomAnchor),
      progress.centerXAnchor.constraint(equalTo: statusView.centerXAnchor),
      progress.centerYAnchor.constraint(equalTo: statusView.centerYAnchor, constant: -24),
      statusLabel.topAnchor.constraint(equalTo: progress.bottomAnchor, constant: 18),
      statusLabel.centerXAnchor.constraint(equalTo: statusView.centerXAnchor),
      statusLabel.widthAnchor.constraint(lessThanOrEqualToConstant: 640),
    ])
  }
}

enum NativeTextInputPreferences {
  static func install(in controller: WKUserContentController) {
    controller.addUserScript(WKUserScript(
      source: source,
      injectionTime: .atDocumentStart,
      forMainFrameOnly: false,
      in: .defaultClient
    ))
  }

  // DSH prompts are code-like text. Keep WebKit from applying macOS writing
  // suggestions and substitutions while leaving the official frontend intact.
  private static let source = #"""
  (() => {
    const preferences = {
      autocapitalize: 'none',
      autocorrect: 'off',
      spellcheck: 'false',
      writingsuggestions: 'false',
    };
    const editableSelector = [
      'textarea',
      'input:not([type])',
      'input[type="text" i]',
      'input[type="search" i]',
      'input[type="email" i]',
      'input[type="url" i]',
      'input[type="tel" i]',
      'input[type="password" i]',
      '[contenteditable]:not([contenteditable="false" i])',
    ].join(',');
    const apply = (element) => {
      if (!(element instanceof HTMLElement) || !element.matches(editableSelector)) return;
      for (const [name, value] of Object.entries(preferences)) {
        if (element.getAttribute(name) !== value) element.setAttribute(name, value);
      }
    };
    const applyDocumentDefaults = () => {
      const root = document.documentElement;
      if (root === null) return;
      for (const [name, value] of Object.entries(preferences)) {
        if (root.getAttribute(name) !== value) root.setAttribute(name, value);
      }
    };
    applyDocumentDefaults();
    if (document.documentElement === null) {
      document.addEventListener('DOMContentLoaded', applyDocumentDefaults, { once: true });
    }
    document.addEventListener('focusin', (event) => apply(event.target), true);
  })();
  """#
}

enum WindowNavigationPolicy {
  enum Destination { case internalPage, externalPage, blocked }

  static func destination(_ url: URL?, serviceURL: URL?) -> Destination {
    guard let url, url.user == nil, url.password == nil,
          url.scheme == "http" || url.scheme == "https", let host = url.host, !host.isEmpty else { return .blocked }
    if NativeBridgePolicy.allows(scheme: url.scheme ?? "", host: host, port: url.port ?? 80, serviceURL: serviceURL) {
      return .internalPage
    }
    return .externalPage
  }
}

enum NativeBridgePolicy {
  static func allows(scheme: String, host: String, port: Int, serviceURL: URL?) -> Bool {
    scheme == "http" && host == "127.0.0.1"
      && serviceURL?.scheme == scheme && serviceURL?.host == host && serviceURL?.port == port
  }
}
