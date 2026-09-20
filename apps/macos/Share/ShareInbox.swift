import Foundation
import Darwin

struct SharedFile: Codable, Sendable {
  let id: String
  let name: String
  let size: Int
}

struct SharedBatch: Codable {
  let id: String
  let files: [SharedFile]
}

enum ShareError: Error { case unavailable, invalid, tooLarge }

/// An atomic, installation-scoped handoff between the sandboxed extension and shell.
final class ShareInbox: @unchecked Sendable {
  static let maxBytes = 50 * 1024 * 1024
  static let maxFiles = 20
  let root: URL

  init(root: URL) { self.root = root }

  static func configured(bundle: Bundle = .main) throws -> ShareInbox {
    guard let group = bundle.object(forInfoDictionaryKey: "DSHShareGroup") as? String,
          let container = FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: group) else { throw ShareError.unavailable }
    return ShareInbox(root: container.appendingPathComponent("ShareInbox", isDirectory: true))
  }

  private func directory(_ name: String) throws -> URL {
    let url = root.appendingPathComponent(name, isDirectory: true)
    try FileManager.default.createDirectory(at: url, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
    for path in [root, url] {
      let values = try path.resourceValues(forKeys: [.isSymbolicLinkKey, .isDirectoryKey])
      guard values.isDirectory == true, values.isSymbolicLink != true else { throw ShareError.invalid }
    }
    return url
  }

  func begin() throws -> URL {
    let stage = try directory("Staging").appendingPathComponent(UUID().uuidString, isDirectory: true)
    try FileManager.default.createDirectory(at: stage, withIntermediateDirectories: false, attributes: [.posixPermissions: 0o700])
    return stage
  }

  /// Called inside NSItemProvider's callback, before its temporary URL expires.
  func copy(_ source: URL, name: String?, into stage: URL, remaining: Int) throws -> SharedFile {
    guard source.isFileURL else { throw ShareError.invalid }
    let (input, size) = try regularFile(source)
    defer { try? input.close() }
    guard size <= remaining, size <= Self.maxBytes else { throw ShareError.tooLarge }
    let id = UUID().uuidString
    let destination = stage.appendingPathComponent(id)
    let candidate = (name?.isEmpty == false ? name! : source.lastPathComponent)
    let displayName = String(candidate.replacingOccurrences(of: "/", with: "_").replacingOccurrences(of: "\\", with: "_").filter { !$0.isNewline && $0.unicodeScalars.allSatisfy { !CharacterSet.controlCharacters.contains($0) } }.prefix(240))
    let descriptor = Darwin.open(destination.path, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW, 0o600)
    guard descriptor >= 0 else { throw ShareError.invalid }
    let output = FileHandle(fileDescriptor: descriptor, closeOnDealloc: true)
    defer { try? output.close() }
    var written = 0
    while written < size {
      let data = try input.read(upToCount: min(65_536, size - written)) ?? Data()
      guard !data.isEmpty else { throw ShareError.invalid }
      try output.write(contentsOf: data)
      written += data.count
    }
    guard (try input.read(upToCount: 1) ?? Data()).isEmpty else { throw ShareError.invalid }
    return SharedFile(id: id, name: displayName.isEmpty ? "attachment" : displayName, size: size)
  }

  private func regularFile(_ url: URL) throws -> (FileHandle, Int) {
    let descriptor = Darwin.open(url.path, O_RDONLY | O_NOFOLLOW | O_NONBLOCK)
    guard descriptor >= 0 else { throw ShareError.invalid }
    var info = stat()
    guard fstat(descriptor, &info) == 0, info.st_mode & S_IFMT == S_IFREG,
          info.st_size >= 0, info.st_size <= Self.maxBytes else { Darwin.close(descriptor); throw ShareError.invalid }
    return (FileHandle(fileDescriptor: descriptor, closeOnDealloc: true), Int(info.st_size))
  }

  func commit(_ stage: URL, files: [SharedFile]) throws -> SharedBatch {
    let batch = SharedBatch(id: stage.lastPathComponent, files: files)
    try validate(batch)
    try JSONEncoder().encode(batch).write(to: stage.appendingPathComponent("manifest.json"), options: .atomic)
    try FileManager.default.moveItem(at: stage, to: directory("Ready").appendingPathComponent(batch.id))
    return batch
  }

  private func validate(_ batch: SharedBatch) throws {
    guard UUID(uuidString: batch.id) != nil, !batch.files.isEmpty, batch.files.count <= Self.maxFiles,
          Set(batch.files.map(\.id)).count == batch.files.count,
          batch.files.allSatisfy({ UUID(uuidString: $0.id) != nil && $0.size >= 0 && $0.size <= Self.maxBytes && !$0.name.isEmpty && $0.name.utf8.count <= 1024 }),
          batch.files.reduce(0, { $0 + $1.size }) <= Self.maxBytes else { throw ShareError.invalid }
  }

  private func batchURL(_ id: String) throws -> URL {
    guard UUID(uuidString: id) != nil else { throw ShareError.invalid }
    let url = try directory("Ready").appendingPathComponent(id, isDirectory: true)
    let values = try url.resourceValues(forKeys: [.isDirectoryKey, .isSymbolicLinkKey])
    guard values.isDirectory == true, values.isSymbolicLink != true else { throw ShareError.invalid }
    return url
  }

  private func read(_ id: String) throws -> SharedBatch {
    let manifest = try batchURL(id).appendingPathComponent("manifest.json")
    let values = try manifest.resourceValues(forKeys: [.fileSizeKey, .isRegularFileKey, .isSymbolicLinkKey])
    guard values.isRegularFile == true, values.isSymbolicLink != true, (values.fileSize ?? Int.max) < 32_768 else { throw ShareError.invalid }
    let batch = try JSONDecoder().decode(SharedBatch.self, from: Data(contentsOf: manifest))
    try validate(batch)
    guard batch.id == id else { throw ShareError.invalid }
    return batch
  }

  func list() throws -> [SharedBatch] {
    let urls = try FileManager.default.contentsOfDirectory(at: directory("Ready"), includingPropertiesForKeys: nil)
    return try urls.sorted(by: { $0.lastPathComponent < $1.lastPathComponent }).prefix(100).map { try read($0.lastPathComponent) }
  }

  func chunk(batchID: String, fileID: String, offset: Int) throws -> String {
    let batch = try read(batchID)
    guard let file = batch.files.first(where: { $0.id == fileID }), offset >= 0, offset <= file.size else { throw ShareError.invalid }
    let url = try batchURL(batchID).appendingPathComponent(file.id)
    let values = try url.resourceValues(forKeys: [.isRegularFileKey, .isSymbolicLinkKey, .fileSizeKey])
    guard values.isRegularFile == true, values.isSymbolicLink != true, values.fileSize == file.size else { throw ShareError.invalid }
    let (handle, size) = try regularFile(url)
    defer { try? handle.close() }
    guard size == file.size else { throw ShareError.invalid }
    try handle.seek(toOffset: UInt64(offset))
    let count = min(64 * 1024, file.size - offset)
    let data = try handle.read(upToCount: count) ?? Data()
    guard data.count == count else { throw ShareError.invalid }
    return data.base64EncodedString()
  }

  /// Keep the original after admission; a WebView reload can lose unsent attachments.
  func acknowledge(_ id: String) throws {
    _ = try read(id)
    try FileManager.default.moveItem(at: batchURL(id), to: directory("Imported").appendingPathComponent(id))
  }
}
