import Foundation

let user = URL(fileURLWithPath: "/example/user")
let managed = RuntimePaths(managedRoot: URL(fileURLWithPath: "/example/install"), userHome: user)
precondition(managed.dshHome.path == "/example/user/.dsh")
precondition(managed.agentsHome.path == "/example/install/agents")
precondition(managed.workspace.path == "/example/install/workspace")
precondition(managed.log.path == "/example/install/logs/launcher.log")
let standalone = RuntimePaths(managedRoot: nil, userHome: user)
precondition(standalone.dshHome.path == "/example/user/.dsh")
let other = RuntimePaths(managedRoot: URL(fileURLWithPath: "/example/another-install"), userHome: user)
precondition(other.dshHome == managed.dshHome)
let configured = RuntimePaths(managedRoot: URL(fileURLWithPath: "/example/install"), userHome: user,
  configuredDshHome: URL(fileURLWithPath: "/example/legacy/home"))
precondition(configured.dshHome.path == "/example/legacy/home")
print("Shared profile paths verified")
