import Foundation

/// Newline-delimited JSON protocol over stdin/stdout, mirroring the plugin's
/// `protocol.ts`. The Helper cannot share the host's auth cookie, so all state
/// and config flow over stdio instead of HTTP.
final class StdioProtocol {
    var onMessage: (([String: Any]) -> Void)?
    private var buffer = Data()
    private var started = false

    func start() {
        guard !started else { return }
        started = true
        FileHandle.standardInput.readabilityHandler = { [weak self] handle in
            guard let self = self else { return }
            let data = handle.availableData
            if data.isEmpty {
                self.stop()
                return
            }
            self.ingest(data)
        }
    }

    func stop() {
        FileHandle.standardInput.readabilityHandler = nil
    }

    func send(kind: String, payload: [String: Any] = [:]) {
        var message: [String: Any] = [
            "protocolVersion": 1,
            "kind": kind,
            "timestamp": Int(Date().timeIntervalSince1970 * 1000),
        ]
        for (key, value) in payload { message[key] = value }
        guard let data = try? JSONSerialization.data(withJSONObject: message) else { return }
        var out = data
        out.append(0x0A)
        FileHandle.standardOutput.write(out)
    }

    private func ingest(_ data: Data) {
        buffer.append(data)
        while let newline = buffer.firstIndex(of: 0x0A) {
            let line = buffer.subdata(in: buffer.startIndex..<newline)
            buffer.removeSubrange(buffer.startIndex...newline)
            guard !line.isEmpty else { continue }
            if let object = try? JSONSerialization.jsonObject(with: line),
               let dict = object as? [String: Any] {
                onMessage?(dict)
            }
        }
    }
}
