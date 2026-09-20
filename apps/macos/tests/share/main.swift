import Foundation

func rejected(_ block: () throws -> Void) {
  do { try block(); fatalError("Expected rejection") } catch {}
}

let root = FileManager.default.temporaryDirectory.appendingPathComponent("dsh-share-test-" + UUID().uuidString)
try FileManager.default.createDirectory(at: root, withIntermediateDirectories: false)
defer { try? FileManager.default.removeItem(at: root) }
let inbox = ShareInbox(root: root.appendingPathComponent("Inbox"))
let source = root.appendingPathComponent("微信聊天.zip")
let bytes = Data((0..<150_000).map { UInt8($0 % 251) })
try bytes.write(to: source)
let stage = try inbox.begin()
let file = try inbox.copy(source, name: "微信聊天.zip", into: stage, remaining: ShareInbox.maxBytes)
do { let batches = try inbox.list(); precondition(batches.isEmpty) }
let batch = try inbox.commit(stage, files: [file])
try FileManager.default.removeItem(at: source)
var restored = Data()
while restored.count < file.size {
  restored.append(Data(base64Encoded: try inbox.chunk(batchID: batch.id, fileID: file.id, offset: restored.count))!)
}
precondition(restored == bytes)
precondition(file.name == "微信聊天.zip")
rejected { _ = try inbox.chunk(batchID: "../", fileID: file.id, offset: 0) }
rejected { _ = try inbox.chunk(batchID: batch.id, fileID: UUID().uuidString, offset: 0) }
rejected { _ = try inbox.chunk(batchID: batch.id, fileID: file.id, offset: -1) }
rejected { _ = try inbox.chunk(batchID: batch.id, fileID: file.id, offset: file.size + 1) }
try inbox.acknowledge(batch.id)
do { let batches = try inbox.list(); precondition(batches.isEmpty) }
precondition(FileManager.default.fileExists(atPath: inbox.root.appendingPathComponent("Imported/" + batch.id + "/" + file.id).path))
try bytes.write(to: source)
let next = try inbox.begin()
rejected { _ = try inbox.copy(source, name: nil, into: next, remaining: 12) }
let link = root.appendingPathComponent("symlink.zip")
try FileManager.default.createSymbolicLink(at: link, withDestinationURL: source)
rejected { _ = try inbox.copy(link, name: nil, into: next, remaining: ShareInbox.maxBytes) }
rejected { _ = try inbox.copy(root, name: nil, into: next, remaining: ShareInbox.maxBytes) }
let second = try inbox.copy(source, name: "a/b\n.zip", into: next, remaining: ShareInbox.maxBytes)
precondition(second.name == "a_b.zip")
let another = try inbox.commit(next, files: [second])
let path = inbox.root.appendingPathComponent("Ready/" + another.id + "/" + second.id)
try FileManager.default.removeItem(at: path)
try FileManager.default.createSymbolicLink(at: path, withDestinationURL: source)
rejected { _ = try inbox.chunk(batchID: another.id, fileID: second.id, offset: 0) }
print("Share inbox preserves bytes, isolates batches, and rejects unsafe input")
