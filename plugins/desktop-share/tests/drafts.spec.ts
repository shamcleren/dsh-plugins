import { expect, it, vi } from 'vitest'
import type { DraftAttachmentId } from '@deepseek-ai/dsh-client-ui-conversation/client'
import { removeDraft } from '../src/client/drafts.js'

it('releases the removed draft upload only after the input accepts removal', () => {
  const id = 'draft-a' as DraftAttachmentId
  const order: string[] = []
  const input = { removeAttachment: vi.fn(() => { order.push('remove'); return true }) }
  const conversation = { releaseDraftAttachment: vi.fn(() => { order.push('release') }) }
  expect(removeDraft(input, conversation, id)).toBe(true)
  expect(input.removeAttachment).toHaveBeenCalledWith(id)
  expect(conversation.releaseDraftAttachment).toHaveBeenCalledWith(id)
  expect(order).toEqual(['remove', 'release'])
})

it('does not revoke an attachment that a busy composer refuses to remove', () => {
  const conversation = { releaseDraftAttachment: vi.fn() }
  expect(removeDraft({ removeAttachment: () => false }, conversation, 'draft-a' as DraftAttachmentId)).toBe(false)
  expect(conversation.releaseDraftAttachment).not.toHaveBeenCalled()
})
