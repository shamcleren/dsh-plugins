import type { InputActions } from '@deepseek-ai/dsh-client-ui-conversation/client'
import { admitBatch } from './admission.js'

export interface CurrentTarget {
  sessionId: Parameters<typeof admitBatch>[4]
  actions: Pick<InputActions, 'addAttachments'>
}

/** Resolve the target on click; a navigation during native reads cancels this import. */
export async function admitCurrent(
  transport: Parameters<typeof admitBatch>[0], batch: Parameters<typeof admitBatch>[1],
  abort: AbortController, conversation: Parameters<typeof admitBatch>[3],
  current: () => CurrentTarget | undefined, subscribe: (listener: () => void) => () => void,
): Promise<void> {
  const target = current()
  if (!target) throw new Error('no-current-conversation')
  const unsubscribe = subscribe(() => { if (current()?.sessionId !== target.sessionId) abort.abort() })
  try {
    if (current()?.sessionId !== target.sessionId) abort.abort()
    await admitBatch(transport, batch, abort.signal, conversation, target.sessionId, target.actions)
  } finally { unsubscribe() }
}
