import Foundation

let root = FileManager.default.temporaryDirectory.appendingPathComponent("dsh-download-test-" + UUID().uuidString)
try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
defer { try? FileManager.default.removeItem(at: root) }
let service = URL(string: "http://127.0.0.1:3196")!
precondition(DownloadPolicy.allows(URL(string: "blob:http://127.0.0.1:3196/example"), serviceURL: service))
precondition(!DownloadPolicy.allows(URL(string: "blob:http://127.0.0.1:3080/example"), serviceURL: service))
precondition(!DownloadPolicy.allows(URL(string: "blob:http://127.0.0.1:3196@evil.test/example"), serviceURL: service))
precondition(!DownloadPolicy.allows(URL(string: "file:///tmp/report.json"), serviceURL: service))
precondition(DownloadPolicy.filename("../../report.json") == "report.json")
precondition(DownloadPolicy.filename("..\\report.json") == "report.json")
precondition(DownloadPolicy.filename("\n\0") == "download")
precondition(DownloadPolicy.filename(String(repeating: "报", count: 300)).utf8.count <= 240)

func assertContents(_ url: URL, _ expected: String) throws {
  let content = try String(contentsOf: url, encoding: .utf8)
  precondition(content == expected)
}
let target = root.appendingPathComponent("report.json")
let fresh = try DownloadDestination(target)
try Data("first".utf8).write(to: fresh.staging)
precondition(!FileManager.default.fileExists(atPath: target.path))
try fresh.publish()
try assertContents(target, "first")

let replace = try DownloadDestination(target)
try Data("replacement".utf8).write(to: replace.staging)
try assertContents(target, "first")
try replace.publish()
try assertContents(target, "replacement")

let changed = try DownloadDestination(target)
try Data("download".utf8).write(to: changed.staging)
try Data("edited meanwhile".utf8).write(to: target, options: .atomic)
do { try changed.publish(); preconditionFailure("must preserve a changed destination") }
catch { changed.discard() }
try assertContents(target, "edited meanwhile")
precondition(!FileManager.default.fileExists(atPath: changed.staging.path))

let link = root.appendingPathComponent("link.json")
try FileManager.default.createSymbolicLink(at: link, withDestinationURL: target)
do { _ = try DownloadDestination(link); preconditionFailure("must refuse a symlink") } catch {}
print("Download isolation and publication verified")
