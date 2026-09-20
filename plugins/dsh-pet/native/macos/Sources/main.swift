import AppKit

// Entry point. Runs the AppKit run loop and drives the pet over stdio.
let protocolIO = StdioProtocol()
let controller = PetController(protocolIO: protocolIO)
// The stdin readability handler fires on a background queue; marshal all
// AppKit mutation to the main thread.
protocolIO.onMessage = { message in
    DispatchQueue.main.async { controller.handle(message) }
}
protocolIO.start()

let app = NSApplication.shared
app.setActivationPolicy(.accessory)
controller.show()

app.run()
