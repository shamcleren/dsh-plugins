import Foundation

/// Persistent paths shared with the repository bootstrap launcher.
struct RuntimePaths {
  let support: URL
  let dshHome: URL
  let agentsHome: URL
  let workspace: URL
  let log: URL

  init(managedRoot: URL?, userHome: URL, configuredDshHome: URL? = nil) {
    support = managedRoot ?? userHome.appendingPathComponent("Library/Application Support/DeepSeek Harness")
    dshHome = configuredDshHome ?? userHome.appendingPathComponent(".dsh")
    agentsHome = support.appendingPathComponent("agents")
    workspace = managedRoot?.appendingPathComponent("workspace")
      ?? userHome.appendingPathComponent("DeepSeek Harness Workspace")
    log = managedRoot?.appendingPathComponent("logs/launcher.log")
      ?? userHome.appendingPathComponent("Library/Logs/DeepSeek Harness/launcher.log")
  }
}
