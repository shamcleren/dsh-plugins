import AppKit

final class QuitTarget: NSObject, ApplicationQuitTarget {
  @objc func quitApplication(_ sender: Any?) {}
}

@main enum MenuChecks {
  @MainActor static func main() {
    let application = NSApplication.shared
    let target = QuitTarget()
    MainMenu.install(for: application, quitTarget: target)
    let applicationMenu = application.mainMenu!.items[0].submenu!
    let quit = applicationMenu.items.first { $0.keyEquivalent == "q" }!
    precondition(quit.target === target)
    precondition(quit.action == #selector(ApplicationQuitTarget.quitApplication(_:)))
    precondition(quit.keyEquivalentModifierMask.contains(.command))
    print("Quit targets the owned download shutdown path")
  }
}
