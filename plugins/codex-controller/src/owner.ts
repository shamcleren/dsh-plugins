/** Host-owned bridge shared with a later Codex preset mount. */
import type { CodexBridge } from './bridge.js'

interface Bound { bridge: CodexBridge; cwdFor(sessionId: string): string | undefined }
let current: Bound | undefined

export function bindBridge(bound: Bound): () => void {
  current = bound
  return () => { if (current === bound) current = undefined }
}

export function currentBridge(): Bound | undefined {
  return current
}
