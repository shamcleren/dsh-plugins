import type { MarketplaceRemote } from './types.ts'

function pause(signal: AbortSignal): Promise<void> {
  signal.throwIfAborted()
  return new Promise((resolve, reject) => {
    const cancel = (): void => { clearTimeout(timer); reject(signal.reason) }
    const timer = setTimeout(() => { signal.removeEventListener('abort', cancel); resolve() }, 750)
    signal.addEventListener('abort', cancel, { once: true })
  })
}

/** Keep the selected address through authorization; never substitute another visible repository. */
export async function connectSource(remote: MarketplaceRemote, repositoryUrl: string, options: {
  authorize: boolean; signal: AbortSignal; open: (url: string) => void; timeoutMessage: string
}): Promise<void> {
  const { signal } = options
  signal.throwIfAborted()
  if (options.authorize) {
    const flow = await remote.beginOAuth({ repositoryUrl })
    signal.throwIfAborted()
    options.open(flow.authorizationUrl)
    const deadline = Date.now() + 10 * 60 * 1000
    while (true) {
      if (Date.now() >= deadline) throw new Error(options.timeoutMessage)
      await pause(signal)
      const status = await remote.oauthStatus(flow.flowId)
      signal.throwIfAborted()
      if (status.status === 'failed') throw new Error(status.message)
      if (status.status === 'complete') break
    }
  }
  signal.throwIfAborted()
  await remote.configure({ repositoryUrl })
  signal.throwIfAborted()
  await remote.refreshCatalog()
}
