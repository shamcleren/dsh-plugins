import type { ConversationController, DraftAttachmentId, SessionInput } from '@deepseek-ai/dsh-client-ui-conversation/client'

/** Only release bytes after the addressed input accepts removal; locked drafts retain ownership. */
export function removeDraft(input: Pick<SessionInput, 'removeAttachment'>, conversation: Pick<ConversationController, 'releaseDraftAttachment'>, id: DraftAttachmentId): boolean {
  if (!input.removeAttachment(id)) return false
  conversation.releaseDraftAttachment(id)
  return true
}
