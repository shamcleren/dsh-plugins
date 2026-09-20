import Foundation

/// Read the official startup URL from this child only; keep its bearer token out of logs.
struct HostOutput {
  let port: Int
  private var pending = Data()
  private(set) var authenticatedURL: URL?

  init(port: Int) { self.port = port }

  mutating func consume(_ bytes: Data, end: Bool = false) -> String {
    pending.append(bytes)
    var output = ""
    while let newline = pending.firstIndex(of: 10) {
      let line = String(decoding: pending[..<newline], as: UTF8.self)
      pending.removeSubrange(...newline)
      output += process(line) + "\n"
    }
    if end && !pending.isEmpty {
      output += process(String(decoding: pending, as: UTF8.self))
      pending.removeAll()
    }
    // Malformed/binary output must not grow an unbounded UI-process buffer.
    if pending.count > 131072 {
      pending.removeAll()
      output += "[Host output line exceeded 128 KiB and was omitted]\n"
    }
    return output
  }

  private mutating func process(_ line: String) -> String {
    let prefix = "dsh web: "
    if line.hasPrefix(prefix), let components = URLComponents(string: String(line.dropFirst(prefix.count))),
       components.scheme == "http", components.host == "127.0.0.1", components.port == port,
       components.user == nil, components.password == nil, components.path == "/", components.fragment == nil,
       let query = components.queryItems, query.count == 1, query[0].name == "token",
       let token = query[0].value, !token.isEmpty,
       token.range(of: "^[A-Za-z0-9_-]+$", options: .regularExpression) != nil {
      authenticatedURL = components.url
    }
    return line.replacingOccurrences(of: "([?&]token=)[^\\s&]+", with: "$1[redacted]", options: .regularExpression)
  }
}
