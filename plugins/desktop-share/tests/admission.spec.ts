import { expect, it, vi } from 'vitest'
import type { ComposerAttachment, DraftAttachmentId } from '@deepseek-ai/dsh-client-ui-conversation/client'
import { admitBatch, ComposerBusy } from '../src/client/admission.js'
import type { SharedBatch } from '../src/client/transport.js'

const batch: SharedBatch = { id: 'AC16B89F-3F3D-413C-B9E9-4C87554A0551', files: [{ id: 'A52A56BB-2DBF-4E08-8FCF-82264217A22E', name: 'chat.zip', size: 3 }] }
const session = 'test-session' as Parameters<typeof admitBatch>[4]
const draft: ComposerAttachment = { kind: 'file', id: 'test-draft' as DraftAttachmentId, file: new File(['zip'], 'chat.zip') }

it('targets the captured session and adds attachments without submitting or replacing text', async () => {
  const conversation = { createDrafts: vi.fn(() => [draft]), releaseDraftAttachments: vi.fn() }
  const actions = { addAttachments: vi.fn(() => true), setDraft: vi.fn(), submit: vi.fn() }
  const transport = { postMessage: vi.fn(async () => 'emlw') }
  await admitBatch(transport, batch, new AbortController().signal, conversation, session, actions)
  expect(conversation.createDrafts).toHaveBeenCalledWith(session, [expect.any(File)])
  expect(actions.addAttachments).toHaveBeenCalledWith([draft.id])
  expect(conversation.releaseDraftAttachments).not.toHaveBeenCalled()
  expect(actions.submit).not.toHaveBeenCalled(); expect(actions.setDraft).not.toHaveBeenCalled()
  expect(transport.postMessage).toHaveBeenCalledTimes(1)
})

it('releases created uploads when the composer refuses admission', async () => {
  const conversation = { createDrafts: vi.fn(() => [draft]), releaseDraftAttachments: vi.fn() }
  await expect(admitBatch({ async postMessage() { return 'emlw' } }, batch, new AbortController().signal, conversation, session, { addAttachments: () => false })).rejects.toBeInstanceOf(ComposerBusy)
  expect(conversation.releaseDraftAttachments).toHaveBeenCalledWith([draft])
})

it('cancelling after a native reply leaves the composer and upload service untouched', async () => {
  const abort = new AbortController()
  const conversation = { createDrafts: vi.fn(() => [draft]), releaseDraftAttachments: vi.fn() }
  const actions = { addAttachments: vi.fn(() => true) }
  await expect(admitBatch({ async postMessage() { abort.abort(); return 'emlw' } }, batch, abort.signal, conversation, session, actions)).rejects.toThrow()
  expect(conversation.createDrafts).not.toHaveBeenCalled(); expect(actions.addAttachments).not.toHaveBeenCalled()
})
