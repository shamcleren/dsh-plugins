import Foundation
var output = HostOutput(port: 3080)
assert(output.consume(Data("dsh web: http://127.0.0.1:3080/?tok".utf8)).isEmpty)
assert(output.authenticatedURL == nil)
let log = output.consume(Data("en=fixture-only\nready\n".utf8))
assert(output.authenticatedURL?.query == "token=fixture-only")
assert(log == "dsh web: http://127.0.0.1:3080/?token=[redacted]\nready\n")
for url in ["https://127.0.0.1:3080/?token=bad", "http://example.com:3080/?token=bad", "http://127.0.0.1:3081/?token=bad", "http://127.0.0.1:3080/?token=bad&extra=1", "http://127.0.0.1:3080/?token=", "http://user@127.0.0.1:3080/?token=bad"] {
  var parser = HostOutput(port: 3080)
  _ = parser.consume(Data(("dsh web: " + url + "\n").utf8))
  assert(parser.authenticatedURL == nil)
}
assert(!output.consume(Data("diagnostic http://example.com/?token=other-secret\n".utf8)).contains("other-secret"))
var bounded = HostOutput(port: 3080)
assert(bounded.consume(Data(repeating: 65, count: 131073)).contains("omitted"))
print("Startup handshake verified")
