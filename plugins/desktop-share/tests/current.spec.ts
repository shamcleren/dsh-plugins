import { expect, it, vi } from 'vitest'
import type { ComposerAttachment, DraftAttachmentId } from '@deepseek-ai/dsh-client-ui-conversation/client'
import { admitCurrent, type CurrentTarget } from '../src/client/current.js'
import type { SharedBatch } from '../src/client/transport.js'

const batch: SharedBatch = { id: 'AC16B89F-3F3D-413C-B9E9-4C87554A0551', files: [{ id: 'A52A56BB-2DBF-4E08-8FCF-82264217A22E', name: 'chat.zip', size: 3 }] }
const draft: ComposerAttachment = { kind: 'file', id: 'draft-a' as DraftAttachmentId, file: new File(['zip'], 'chat.zip') }
function fixture() {
  const first: CurrentTarget = { sessionId: 'session-a' as CurrentTarget['sessionId'], actions: { addAttachments: vi.fn(() => true) } }
  const second: CurrentTarget = { sessionId: 'session-b' as CurrentTarget['sessionId'], actions: { addAttachments: vi.fn(() => true) } }
  let target: CurrentTarget | undefined = first
  const listeners = new Set<() => void>()
  return { first, second, listeners,
    current: () => target,
    select(value: CurrentTarget | undefined) { target = value; for (const listener of listeners) listener() },
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener) } },
    conversation: { createDrafts: vi.fn(() => [draft]), releaseDraftAttachments: vi.fn() },
  }
}
it('uses the conversation selected before the click without a second picker', async () => {
  const f = fixture(); f.select(f.second)
  await admitCurrent({ postMessage: async () => 'emlw' }, batch, new AbortController(), f.conversation, f.current, f.subscribe)
  expect(f.conversation.createDrafts).toHaveBeenCalledWith(f.second.sessionId, [expect.any(File)])
  expect(f.second.actions.addAttachments).toHaveBeenCalledWith([draft.id])
  expect(f.first.actions.addAttachments).not.toHaveBeenCalled()
  expect(f.listeners.size).toBe(0)
})
it('cancels a pending read on navigation and preserves both drafts', async () => {
  const f = fixture()
  const transport = { postMessage: async () => { f.select(f.second); return 'emlw' } }
  await expect(admitCurrent(transport, batch, new AbortController(), f.conversation, f.current, f.subscribe)).rejects.toThrow()
  expect(f.conversation.createDrafts).not.toHaveBeenCalled()
  expect(f.first.actions.addAttachments).not.toHaveBeenCalled()
  expect(f.second.actions.addAttachments).not.toHaveBeenCalled()
  expect(f.listeners.size).toBe(0)
})
it('does not read files or create a session when no conversation is open', async () => {
  const f = fixture(); f.select(undefined)
  const transport = { postMessage: vi.fn() }
  await expect(admitCurrent(transport, batch, new AbortController(), f.conversation, f.current, f.subscribe)).rejects.toThrow('no-current-conversation')
  expect(transport.postMessage).not.toHaveBeenCalled()
  expect(f.listeners.size).toBe(0)
})
it('unsubscribes navigation after native read failure', async () => {
  const f = fixture()
  await expect(admitCurrent({ postMessage: async () => { throw new Error('read-failed') } }, batch, new AbortController(), f.conversation, f.current, f.subscribe)).rejects.toThrow('read-failed')
  expect(f.listeners.size).toBe(0)
})
