import Foundation

let service = URL(string: "http://127.0.0.1:3081")!
precondition(NativeBridgePolicy.allows(scheme: "http", host: "127.0.0.1", port: 3081, serviceURL: service))
precondition(!NativeBridgePolicy.allows(scheme: "http", host: "127.0.0.1", port: 3080, serviceURL: service))
precondition(!NativeBridgePolicy.allows(scheme: "https", host: "127.0.0.1", port: 3081, serviceURL: service))
precondition(!NativeBridgePolicy.allows(scheme: "http", host: "localhost", port: 3081, serviceURL: service))
precondition(!NativeBridgePolicy.allows(scheme: "http", host: "127.0.0.1", port: 3081, serviceURL: nil))
let custom = URL(string: "http://127.0.0.1:3082")!
precondition(NativeBridgePolicy.allows(scheme: "http", host: "127.0.0.1", port: 3082, serviceURL: custom))
precondition(!NativeBridgePolicy.allows(scheme: "http", host: "127.0.0.1", port: 3081, serviceURL: custom))
print("Native bridge origin isolation verified")
