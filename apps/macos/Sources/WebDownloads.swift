import AppKit
import WebKit

enum DownloadPolicy {
  static func allows(_ url: URL?, serviceURL: URL?) -> Bool {
    guard let url else { return false }
    let source = url.scheme == "blob" ? URL(string: String(url.absoluteString.dropFirst(5))) : url
    guard let source, source.user == nil, source.password == nil else { return false }
    return NativeBridgePolicy.allows(scheme: source.scheme ?? "", host: source.host ?? "", port: source.port ?? 80, serviceURL: serviceURL)
  }

  static func filename(_ suggestion: String) -> String {
    let basename = (suggestion.replacingOccurrences(of: "\\", with: "/") as NSString).lastPathComponent
    var result = String(basename.unicodeScalars.filter { !CharacterSet.controlCharacters.contains($0) })
      .replacingOccurrences(of: ":", with: "_")
    while result.utf8.count > 240 { result.removeLast() }
    return result.isEmpty || result == "." || result == ".." ? "download" : result
  }
}

/** WebKit writes only to an owned staging file; a failed download never damages the chosen destination. */
struct DownloadDestination {
  let target: URL
  let staging: URL
  private let original: NSDictionary?

  init(_ target: URL) throws {
    guard target.isFileURL else { throw CocoaError(.fileWriteInvalidFileName) }
    self.target = target
    staging = target.deletingLastPathComponent().appendingPathComponent(".dsh-download-" + UUID().uuidString)
    original = try Self.identity(target)
  }

  private static func identity(_ url: URL) throws -> NSDictionary? {
    do {
      let attributes = try FileManager.default.attributesOfItem(atPath: url.path)
      guard attributes[.type] as? FileAttributeType == .typeRegular else { throw CocoaError(.fileWriteFileExists) }
      return NSDictionary(dictionary: attributes.filter { [.systemNumber, .systemFileNumber, .size, .modificationDate].contains($0.key) })
    } catch let error as CocoaError where error.code == .fileReadNoSuchFile { return nil }
  }

  func publish() throws {
    let current = try Self.identity(target)
    guard current == original else { throw CocoaError(.fileWriteFileExists) }
    if original == nil { try FileManager.default.moveItem(at: staging, to: target) }
    else { _ = try FileManager.default.replaceItemAt(target, withItemAt: staging) }
  }

  func discard() { try? FileManager.default.removeItem(at: staging) }
}

/** Own downloads and save panels for one window; no download opens or executes the resulting file. */
final class WebDownloads: NSObject, WKDownloadDelegate {
  private struct Item {
    let download: WKDownload
    let origin: URL
    var destination: DownloadDestination?
    var panel: NSSavePanel?
  }
  private weak var window: NSWindow?
  private var items: [ObjectIdentifier: Item] = [:]
  private let cancellations = DispatchGroup()
  private var stopped = false
  private var cancellationCount = 0

  var hasPendingWork: Bool { !items.isEmpty || cancellationCount > 0 }

  init(window: NSWindow) { self.window = window }

  func accept(_ download: WKDownload, origin: URL?) {
    guard let origin, !stopped else { download.cancel { _ in }; return }
    items[ObjectIdentifier(download)] = Item(download: download, origin: origin)
    download.delegate = self
  }

  func download(_ download: WKDownload, willPerformHTTPRedirection response: HTTPURLResponse, newRequest request: URLRequest, decisionHandler: @escaping (WKDownload.RedirectPolicy) -> Void) {
    decisionHandler(DownloadPolicy.allows(request.url, serviceURL: items[ObjectIdentifier(download)]?.origin) ? .allow : .cancel)
  }

  func resume() { stopped = false }

  func stop(completion: (() -> Void)? = nil) {
    stopped = true
    let owned = Array(items.values)
    items.removeAll()
    for item in owned {
      item.panel?.cancel(nil)
      cancellations.enter()
      cancellationCount += 1
      item.download.cancel { [self] _ in
        item.destination?.discard()
        cancellationCount -= 1
        cancellations.leave()
      }
    }
    if let completion { cancellations.notify(queue: .main, execute: completion) }
  }

  func download(_ download: WKDownload, decideDestinationUsing response: URLResponse, suggestedFilename: String, completionHandler: @escaping (URL?) -> Void) {
    let id = ObjectIdentifier(download)
    guard let window, items[id] != nil, window.attachedSheet == nil else { completionHandler(nil); return }
    let panel = NSSavePanel()
    panel.nameFieldStringValue = DownloadPolicy.filename(suggestedFilename)
    panel.canCreateDirectories = true
    items[id]?.panel = panel
    panel.beginSheetModal(for: window) { [weak self] response in
      guard let self, self.items[id] != nil else { completionHandler(nil); return }
      self.items[id]?.panel = nil
      guard response == .OK, let url = panel.url else { completionHandler(nil); return }
      do {
        let destination = try DownloadDestination(url)
        self.items[id]?.destination = destination
        completionHandler(destination.staging)
      } catch { completionHandler(nil); self.show(error) }
    }
  }

  func downloadDidFinish(_ download: WKDownload) {
    guard let item = items.removeValue(forKey: ObjectIdentifier(download)), let destination = item.destination else { return }
    do { try destination.publish() }
    catch { destination.discard(); show(error) }
  }

  func download(_ download: WKDownload, didFailWithError error: Error, resumeData: Data?) {
    guard let item = items.removeValue(forKey: ObjectIdentifier(download)) else { return }
    item.destination?.discard()
    if (error as NSError).code != NSURLErrorCancelled { show(error) }
  }

  private func show(_ error: Error) {
    guard let window, window.attachedSheet == nil else { return }
    NSAlert(error: error).beginSheetModal(for: window)
  }
}
