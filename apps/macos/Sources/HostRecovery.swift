import Foundation

/// Recovery belongs to the native App, never to a tool owned by the exiting Host.
struct HostRecovery {
  private var attempts: [TimeInterval] = []

  mutating func delayAfterExit(wasReady: Bool, now: TimeInterval) -> TimeInterval? {
    guard wasReady else { return nil }
    attempts.removeAll { now - $0 >= 60 }
    guard attempts.count < 3 else { return nil }
    let delay: TimeInterval = [1, 2, 4][attempts.count]
    attempts.append(now)
    return delay
  }
}
