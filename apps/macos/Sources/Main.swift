import AppKit

@main
enum DeepSeekHarnessApplication {
  static func main() {
    let application = NSApplication.shared
    let delegate = AppDelegate()
    application.delegate = delegate
    application.run()
  }
}
