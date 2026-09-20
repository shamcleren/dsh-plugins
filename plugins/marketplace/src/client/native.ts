interface NativeMessageHandler {
  postMessage(message: { action: 'restartHost' } | { action: 'openExternal'; url: string }): void
}

interface NativeWindow extends Window {
  webkit?: { messageHandlers?: { dshNative?: NativeMessageHandler } }
}

/** Request a native Host restart when the native bridge is available. */
export function requestNativeRestart(): boolean {
  const handler = (window as NativeWindow).webkit?.messageHandlers?.dshNative
  if (handler === undefined) return false
  handler.postMessage({ action: 'restartHost' })
  return true
}

/** Open an OAuth URL through the native bridge when available. */
export function requestNativeOpen(url: string): boolean {
  const handler = (window as NativeWindow).webkit?.messageHandlers?.dshNative
  if (handler === undefined) return false
  handler.postMessage({ action: 'openExternal', url })
  return true
}
