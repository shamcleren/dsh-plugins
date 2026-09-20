import AppKit
import UniformTypeIdentifiers

@main enum ProviderCheck {
  static func main() async throws {
    let root = FileManager.default.temporaryDirectory.appendingPathComponent("dsh-provider-" + UUID().uuidString)
    try FileManager.default.createDirectory(at: root, withIntermediateDirectories: false)
    defer { try? FileManager.default.removeItem(at: root) }
    let source = root.appendingPathComponent("聊天记录.zip")
    let data = Data("synthetic archive bytes".utf8)
    try data.write(to: source)
    let inbox = ShareInbox(root: root.appendingPathComponent("Inbox"))
    let stage = try inbox.begin()
    let provider = NSItemProvider(contentsOf: source)!
    let file = try await ShareViewController.receive(provider, inbox: inbox, stage: stage, remaining: ShareInbox.maxBytes)
    let batch = try inbox.commit(stage, files: [file])
    try FileManager.default.removeItem(at: source)
    precondition(file.name == "聊天记录.zip")
    let encoded = try inbox.chunk(batchID: batch.id, fileID: file.id, offset: 0)
    precondition(Data(base64Encoded: encoded) == data)
    print("System item provider preserves original filenames and content")
  }
}
