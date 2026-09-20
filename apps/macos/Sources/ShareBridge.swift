import AppKit
import WebKit

/// The page can read only received batches, never an arbitrary filesystem path.
final class ShareBridge: NSObject, WKScriptMessageHandlerWithReply {
  var serviceURL: URL?
  private let inbox: ShareInbox?
  var available: Bool { inbox != nil }
  private let queue = DispatchQueue(label: "dsh.share-inbox")

  init(inbox: ShareInbox? = try? ShareInbox.configured()) { self.inbox = inbox }

  func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage, replyHandler: @escaping (Any?, String?) -> Void) {
    let origin = message.frameInfo.securityOrigin
    guard message.frameInfo.isMainFrame,
          NativeBridgePolicy.allows(scheme: origin.protocol, host: origin.host, port: origin.port, serviceURL: serviceURL),
          let body = message.body as? [String: Any], let action = body["action"] as? String else { replyHandler(nil, "share-origin-denied"); return }
    guard let inbox else { replyHandler(nil, "share-unavailable"); return }
    if action == "reveal" { NSWorkspace.shared.open(inbox.root); replyHandler(true, nil); return }
    queue.async {
      do {
        let result: Any
        switch action {
        case "list": result = try JSONSerialization.jsonObject(with: JSONEncoder().encode(inbox.list()))
        case "read":
          guard let batch = body["batch"] as? String, let file = body["file"] as? String,
                let number = body["offset"] as? NSNumber, CFGetTypeID(number) != CFBooleanGetTypeID(), number.doubleValue == Double(number.intValue) else { throw ShareError.invalid }
          result = try inbox.chunk(batchID: batch, fileID: file, offset: number.intValue)
        case "ack":
          guard let batch = body["batch"] as? String else { throw ShareError.invalid }
          try inbox.acknowledge(batch); result = true
        default: throw ShareError.invalid
        }
        DispatchQueue.main.async { replyHandler(result, nil) }
      } catch {
        DispatchQueue.main.async { replyHandler(nil, "share-read-failed") }
      }
    }
  }
}
