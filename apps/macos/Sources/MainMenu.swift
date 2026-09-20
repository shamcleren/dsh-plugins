import AppKit

enum MainMenu {
  static func install(for application: NSApplication, quitTarget: ApplicationQuitTarget) {
    let mainMenu = NSMenu()
    mainMenu.addItem(applicationMenu(quitTarget: quitTarget))
    mainMenu.addItem(editMenu())
    let window = windowMenu()
    mainMenu.addItem(window)
    application.mainMenu = mainMenu
    application.windowsMenu = window.submenu
  }

  private static func applicationMenu(quitTarget: ApplicationQuitTarget) -> NSMenuItem {
    let root = NSMenuItem()
    let menu = NSMenu(title: "DeepSeek Harness")
    root.submenu = menu
    menu.addItem(
      withTitle: "About DeepSeek Harness",
      action: #selector(NSApplication.orderFrontStandardAboutPanel(_:)),
      keyEquivalent: ""
    )
    menu.addItem(.separator())
    menu.addItem(
      withTitle: "Hide DeepSeek Harness",
      action: #selector(NSApplication.hide(_:)),
      keyEquivalent: "h"
    )
    let hideOthers = menu.addItem(
      withTitle: "Hide Others",
      action: #selector(NSApplication.hideOtherApplications(_:)),
      keyEquivalent: "h"
    )
    hideOthers.keyEquivalentModifierMask = [.command, .option]
    menu.addItem(
      withTitle: "Show All",
      action: #selector(NSApplication.unhideAllApplications(_:)),
      keyEquivalent: ""
    )
    menu.addItem(.separator())
    let quit = menu.addItem(
      withTitle: "Quit DeepSeek Harness",
      action: #selector(ApplicationQuitTarget.quitApplication(_:)),
      keyEquivalent: "q"
    )
    quit.target = quitTarget
    return root
  }

  private static func editMenu() -> NSMenuItem {
    let root = NSMenuItem()
    let menu = NSMenu(title: "Edit")
    root.submenu = menu
    menu.addItem(
      withTitle: "Undo",
      action: #selector(UndoResponder.undo(_:)),
      keyEquivalent: "z"
    )
    let redo = menu.addItem(
      withTitle: "Redo",
      action: #selector(UndoResponder.redo(_:)),
      keyEquivalent: "z"
    )
    redo.keyEquivalentModifierMask = [.command, .shift]
    menu.addItem(.separator())
    menu.addItem(withTitle: "Cut", action: #selector(NSText.cut(_:)), keyEquivalent: "x")
    menu.addItem(withTitle: "Copy", action: #selector(NSText.copy(_:)), keyEquivalent: "c")
    menu.addItem(withTitle: "Paste", action: #selector(NSText.paste(_:)), keyEquivalent: "v")
    let pastePlain = menu.addItem(
      withTitle: "Paste and Match Style",
      action: #selector(NSTextView.pasteAsPlainText(_:)),
      keyEquivalent: "v"
    )
    pastePlain.keyEquivalentModifierMask = [.command, .option, .shift]
    menu.addItem(withTitle: "Delete", action: #selector(NSText.delete(_:)), keyEquivalent: "")
    menu.addItem(.separator())
    menu.addItem(
      withTitle: "Select All",
      action: #selector(NSText.selectAll(_:)),
      keyEquivalent: "a"
    )
    return root
  }

  private static func windowMenu() -> NSMenuItem {
    let root = NSMenuItem()
    let menu = NSMenu(title: "Window")
    root.submenu = menu
    menu.addItem(
      withTitle: "Minimize",
      action: #selector(NSWindow.performMiniaturize(_:)),
      keyEquivalent: "m"
    )
    menu.addItem(
      withTitle: "Zoom",
      action: #selector(NSWindow.performZoom(_:)),
      keyEquivalent: ""
    )
    menu.addItem(.separator())
    menu.addItem(
      withTitle: "Bring All to Front",
      action: #selector(NSApplication.arrangeInFront(_:)),
      keyEquivalent: ""
    )
    return root
  }
}

@MainActor @objc protocol ApplicationQuitTarget: AnyObject {
  func quitApplication(_ sender: Any?)
}

@objc private protocol UndoResponder {
  func undo(_ sender: Any?)
  func redo(_ sender: Any?)
}
