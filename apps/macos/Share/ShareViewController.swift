import AppKit
import UniformTypeIdentifiers

@objc(DSHShareViewController)
final class ShareViewController: NSViewController {
  private var work: Task<Void, Never>?
  private let label = NSTextField(wrappingLabelWithString: NSLocalizedString("Receiving shared files…", comment: "Share progress"))

  override func loadView() {
    view = NSView(frame: NSRect(x: 0, y: 0, width: 340, height: 90))
    label.frame = NSRect(x: 20, y: 20, width: 300, height: 50)
    view.addSubview(label)
  }

  override func viewDidLoad() {
    super.viewDidLoad()
    guard work == nil, let context = extensionContext else { return }
    work = Task { @MainActor in
      var staging: URL?
      do {
        let inbox = try ShareInbox.configured()
        let providers = (context.inputItems as? [NSExtensionItem] ?? []).flatMap { $0.attachments ?? [] }
        guard !providers.isEmpty, providers.count <= ShareInbox.maxFiles else { throw ShareError.invalid }
        let stage = try inbox.begin()
        staging = stage
        var files: [SharedFile] = []
        for provider in providers {
          try Task.checkCancellation()
          let remaining = ShareInbox.maxBytes - files.reduce(0) { $0 + $1.size }
          let file = try await Self.receive(provider, inbox: inbox, stage: stage, remaining: remaining)
          files.append(file)
        }
        try Task.checkCancellation()
        _ = try inbox.commit(stage, files: files)
        staging = nil
        // Data is durable before Launch Services is notified; reopening the app
        // manually also discovers the batch if activation is refused by macOS.
        let app = Bundle.main.bundleURL.deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
        if app.pathExtension == "app" {
          let options = NSWorkspace.OpenConfiguration()
          options.addsToRecentItems = false
          NSWorkspace.shared.openApplication(at: app, configuration: options, completionHandler: { _, _ in })
        }
        context.completeRequest(returningItems: nil)
      } catch {
        if let staging { try? FileManager.default.removeItem(at: staging) }
        context.cancelRequest(withError: NSError(domain: "DSHShare", code: 1, userInfo: [NSLocalizedDescriptionKey: NSLocalizedString("Could not receive these files. Share at most 20 files and 50 MB per batch, then try again.", comment: "Share error")]))
      }
    }
  }

  deinit { work?.cancel() }

  static func receive(_ provider: NSItemProvider, inbox: ShareInbox, stage: URL, remaining: Int) async throws -> SharedFile {
    let types = provider.registeredTypeIdentifiers
    var suggestedName = provider.suggestedName
    // Some system providers name the temporary file after its UTI. Recover the
    // original display name separately; only the file representation supplies bytes.
    if suggestedName?.isEmpty != false, provider.hasItemConformingToTypeIdentifier(UTType.fileURL.identifier) {
      let original: URL? = await withCheckedContinuation { continuation in
        _ = provider.loadObject(ofClass: NSURL.self) { value, _ in continuation.resume(returning: value as? URL) }
      }
      suggestedName = original?.lastPathComponent
    }
    let preferredName = suggestedName
    guard let type = types.first(where: { $0 != UTType.fileURL.identifier && UTType($0)?.conforms(to: .data) == true }) ?? types.first(where: { $0 == UTType.fileURL.identifier }) else { throw ShareError.invalid }
    return try await withCheckedThrowingContinuation { continuation in
      let copy: @Sendable (URL?, Error?) -> Void = { url, error in
        do {
          if let error { throw error }
          guard let url else { throw ShareError.invalid }
          let scoped = url.startAccessingSecurityScopedResource()
          defer { if scoped { url.stopAccessingSecurityScopedResource() } }
          // Never let an NSItemProvider temporary URL escape its callback.
          var name = preferredName ?? url.lastPathComponent
          if (name as NSString).pathExtension.isEmpty, let suffix = UTType(type)?.preferredFilenameExtension { name += "." + suffix }
          let file: SharedFile
          if type == UTType.fileURL.identifier {
            var result: Result<SharedFile, Error>?
            var coordinationError: NSError?
            NSFileCoordinator().coordinate(readingItemAt: url, options: .withoutChanges, error: &coordinationError) { coordinated in
              result = Result { try inbox.copy(coordinated, name: name, into: stage, remaining: remaining) }
            }
            if let coordinationError { throw coordinationError }
            guard let result else { throw ShareError.invalid }
            file = try result.get()
          } else { file = try inbox.copy(url, name: name, into: stage, remaining: remaining) }
          continuation.resume(returning: file)
        } catch { continuation.resume(throwing: error) }
      }
      if type == UTType.fileURL.identifier {
        _ = provider.loadObject(ofClass: NSURL.self) { object, error in copy(object as? URL, error) }
      } else {
        provider.loadFileRepresentation(forTypeIdentifier: type, completionHandler: copy)
      }
    }
  }
}
