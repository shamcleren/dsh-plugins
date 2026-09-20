import AppKit
import WebKit

final class NavigationObserver: NSObject, WKNavigationDelegate {
  let controller: MainWindowController
  var finished = 0
  var cancelled = 0
  var downloads = 0
  init(_ controller: MainWindowController) { self.controller = controller }

  func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
    controller.webView(webView, decidePolicyFor: action) { policy in
      if policy == .cancel { self.cancelled += 1 }
      if policy == .download { self.downloads += 1 }
      // Observe the production download decision without opening a Save panel.
      decisionHandler(policy == .download ? .cancel : policy)
    }
  }

  func webView(_ webView: WKWebView, decidePolicyFor response: WKNavigationResponse, decisionHandler: @escaping (WKNavigationResponsePolicy) -> Void) {
    controller.webView(webView, decidePolicyFor: response) { policy in
      if policy == .cancel { self.cancelled += 1 }
      if policy == .download { self.downloads += 1 }
      decisionHandler(policy == .download ? .cancel : policy)
    }
  }

  func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) { finished += 1 }
}

func waitFor(_ label: String, _ predicate: () -> Bool) {
  let deadline = Date().addingTimeInterval(15)
  while !predicate() {
    precondition(Date() < deadline, "Timed out: " + label)
    RunLoop.current.run(until: Date().addingTimeInterval(0.01))
  }
}

@main enum NavigationChecks {
  @MainActor static func main() {
    NSApplication.shared.setActivationPolicy(.accessory)
    let service = URL(string: CommandLine.arguments[1])!
    let external = "https://github.com/TencentBlueKing/bk-aidev/blob/example/source_management.py#L213"
    var opened: [URL] = []
    let controller = MainWindowController(websiteDataStore: .nonPersistent(), openExternal: { opened.append($0) })
    let webView = controller.window!.contentView!.subviews.compactMap { $0 as? WKWebView }.first!
    // Synthetic clicks have no OS user gesture; let the fixture exercise popup delegates.
    webView.configuration.preferences.javaScriptCanOpenWindowsAutomatically = true
    let observer = NavigationObserver(controller)
    webView.navigationDelegate = observer
    controller.load(service)
    waitFor("initial Host load") { observer.finished == 1 }

    @discardableResult func js(_ script: String) -> Any? {
      var done = false
      var result: Any?
      webView.evaluateJavaScript(script) { value, error in
        precondition(error == nil, "JavaScript failed: \(String(describing: error))")
        result = value
        done = true
      }
      waitFor("JavaScript completion") { done }
      return result
    }

    func assertHost() {
      precondition(js("document.body.id") as? String == "dsh-fixture", "External page replaced the Host")
      precondition(opened.allSatisfy { $0 != service })
    }

    for script in [
      "let a=document.createElement('a'); a.href='\(external)'; document.body.append(a); a.click()",
      "let a=document.createElement('a'); a.href='\(external)'; a.target='_blank'; document.body.append(a); a.click()",
      "window.open('\(external)', '_blank'); void 0",
      "location.href='\(external)'",
    ] {
      let count = opened.count
      js("(()=>{\(script)})()")
      waitFor("external handoff: " + script) { opened.count > count }
      precondition(opened.count == count + 1)
      precondition(opened.last?.absoluteString == external)
      assertHost()
    }

    // A same-origin request redirects to another origin without another click.
    let beforeRedirect = opened.count
    js("location.href='/redirect'")
    waitFor("redirect handoff") { opened.count > beforeRedirect }
    precondition(opened.count == beforeRedirect + 1)
    precondition(opened.last?.host == "localhost")
    assertHost()

    for script in [
      "location.href='/internal'",
      "let a=document.createElement('a'); a.href='/popup'; a.target='_blank'; document.body.append(a); a.click()",
    ] {
      let finished = observer.finished
      js("(()=>{\(script)})()")
      waitFor("internal navigation") { observer.finished > finished }
      assertHost()
      precondition(opened.count == beforeRedirect + 1)
    }

    let cancelled = observer.cancelled
    js("location.href='data:text/html,unexpected'")
    waitFor("blocked scheme") { observer.cancelled > cancelled }
    assertHost()

    js("(()=>{let a=document.createElement('a'); a.href=URL.createObjectURL(new Blob(['report'],{type:'text/html'})); a.download='report.html'; document.body.append(a); a.click()})()")
    waitFor("Blob download") { observer.downloads == 1 }
    assertHost()
    js("location.href='/download'")
    waitFor("response download") { observer.downloads == 2 }
    assertHost()

    precondition(WindowNavigationPolicy.destination(service.appendingPathComponent("session"), serviceURL: service) == .internalPage)
    for raw in ["http://127.0.0.1:1/", "https://127.0.0.1/", "http://localhost/", external] {
      precondition(WindowNavigationPolicy.destination(URL(string: raw), serviceURL: service) == .externalPage)
    }
    for raw in ["file:///tmp/page.html", "data:text/html,page", "javascript:alert(1)", "custom:launch", "blob:\(service)/id", "https://user:password@example.com/"] {
      precondition(WindowNavigationPolicy.destination(URL(string: raw), serviceURL: service) == .blocked)
    }
    precondition(WindowNavigationPolicy.destination(nil, serviceURL: service) == .blocked)
    controller.window?.close()
    print("External links preserve the Host window; internal navigation and downloads remain available")
  }
}
