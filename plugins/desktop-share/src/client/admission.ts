import type { ConversationController, InputActions } from '@deepseek-ai/dsh-client-ui-conversation/client'
import { receiveFiles, type SharedBatch, type ShareTransport } from './transport.js'

export class ComposerBusy extends Error {}

/** Capture the addressed composer before asynchronous reads; never resolve a new active session midway. */
export async function admitBatch(
  transport: ShareTransport, batch: SharedBatch, signal: AbortSignal,
  conversation: Pick<ConversationController, 'createDrafts' | 'releaseDraftAttachments'>,
  sessionId: Parameters<ConversationController['createDrafts']>[0],
  actions: Pick<InputActions, 'addAttachments'>,
): Promise<void> {
  const files = await receiveFiles(transport, batch, signal)
  signal.throwIfAborted()
  const drafts = conversation.createDrafts(sessionId, files)
  let attached = false
  try { attached = actions.addAttachments(drafts.map(draft => draft.id)) }
  finally { if (!attached) conversation.releaseDraftAttachments(drafts) }
  if (!attached) throw new ComposerBusy()
}
