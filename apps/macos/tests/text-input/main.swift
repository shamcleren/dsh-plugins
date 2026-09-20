import AppKit
import WebKit

final class TextInputNavigationObserver: NSObject, WKNavigationDelegate {
  var finished = false
  func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) { finished = true }
}

func waitFor(_ label: String, _ predicate: () -> Bool) {
  let deadline = Date().addingTimeInterval(15)
  while !predicate() {
    precondition(Date() < deadline, "Timed out: " + label)
    RunLoop.current.run(until: Date().addingTimeInterval(0.01))
  }
}

@main enum TextInputChecks {
  @MainActor static func main() {
    NSApplication.shared.setActivationPolicy(.accessory)
    let controller = MainWindowController(websiteDataStore: .nonPersistent())
    let webView = controller.window!.contentView!.subviews.compactMap { $0 as? WKWebView }.first!
    let scripts = webView.configuration.userContentController.userScripts
    precondition(scripts.count == 1)
    precondition(scripts[0].injectionTime == .atDocumentStart)
    precondition(!scripts[0].isForMainFrameOnly)

    let observer = TextInputNavigationObserver()
    webView.navigationDelegate = observer
    webView.loadHTMLString(#"""
      <!doctype html>
      <html>
        <head><script>window.rootPreferenceAtParse = document.documentElement.getAttribute('writingsuggestions')</script></head>
        <body>
          <input id="input" type="text" autocapitalize="sentences" autocorrect="on" spellcheck="true" writingsuggestions="true">
          <textarea id="textarea" autocapitalize="sentences" autocorrect="on" spellcheck="true" writingsuggestions="true"></textarea>
          <div id="editor" contenteditable="true" autocapitalize="sentences" autocorrect="on" spellcheck="true" writingsuggestions="true"></div>
          <input id="checkbox" type="checkbox" autocapitalize="sentences" autocorrect="on" spellcheck="true" writingsuggestions="true">
        </body>
      </html>
      """#, baseURL: nil)
    waitFor("fixture load") { observer.finished }

    var done = false
    var result: Any?
    webView.evaluateJavaScript(#"""
      (() => {
        const dynamic = document.createElement('textarea');
        dynamic.id = 'dynamic';
        dynamic.setAttribute('autocapitalize', 'sentences');
        dynamic.setAttribute('autocorrect', 'on');
        dynamic.setAttribute('spellcheck', 'true');
        dynamic.setAttribute('writingsuggestions', 'true');
        document.body.append(dynamic);
        for (const id of ['input', 'textarea', 'editor', 'dynamic', 'checkbox']) {
          document.getElementById(id).dispatchEvent(new FocusEvent('focusin', { bubbles: true }));
        }
        const values = [window.rootPreferenceAtParse];
        for (const element of [document.documentElement, input, textarea, editor, dynamic, checkbox]) {
          for (const name of ['autocapitalize', 'autocorrect', 'spellcheck', 'writingsuggestions']) {
            values.push(element.getAttribute(name));
          }
        }
        return values.map(value => value ?? '<missing>').join('|');
      })()
      """#) { value, error in
        precondition(error == nil, "JavaScript failed: \(String(describing: error))")
        result = value
        done = true
    }
    waitFor("preference assertions") { done }
    let disabled = "none|off|false|false"
    precondition(result as? String == (["false"] + Array(repeating: disabled, count: 5) + ["sentences|on|true|true"]).joined(separator: "|"))
    controller.window?.close()
    print("Native writing suggestions and text corrections are disabled")
  }
}
