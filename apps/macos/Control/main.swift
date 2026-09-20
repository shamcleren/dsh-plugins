import Foundation
import Darwin

guard CommandLine.arguments.count == 1 else { exit(64) }
let executable = URL(fileURLWithPath: CommandLine.arguments[0]).resolvingSymlinksInPath()
let app = executable.deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
HostRestartRequest.send(app: app)
