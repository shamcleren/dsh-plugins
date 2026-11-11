import { expect, it, vi } from 'vitest'
import { collectFileBytes, readPresentedFile } from '../../src/adapters/wechat/files.js'
import { TurnProjection } from '../../src/adapters/wechat/reply.js'

it('collects only bounded file bytes and respects cancellation', async () => {
  async function* chunks() { yield Buffer.from('ab'); yield Buffer.from('cd') }
  await expect(collectFileBytes(chunks(), 4, new AbortController().signal)).resolves.toEqual(Buffer.from('abcd'))
  await expect(collectFileBytes(chunks(), 3, new AbortController().signal)).rejects.toThrow('exceeds')
  const abort = new AbortController(); abort.abort(new Error('cancelled'))
  await expect(collectFileBytes(chunks(), 10, abort.signal)).rejects.toThrow('cancelled')
})

it('reads presented files through public workspace policy and rejects a changed version', async () => {
  const stat = vi.fn(async () => ({ absolutePath: '/workspace/report.txt', bytes: 4, version: 'one' }))
  const readBytes = vi.fn(async () => ({ absolutePath: '/workspace/report.txt', offset: 0, version: 'one', data: Buffer.from('data'), eof: true }))
  const ctx = { sessionController: { inspect: async () => ({ meta: { cwd: '/workspace' } }) }, workspaceFiles: { stat, readBytes } }
  await expect(readPresentedFile(ctx as never, 'session-one', 'report.txt', '', 10, new AbortController().signal))
    .resolves.toEqual({ name: 'report.txt', bytes: Buffer.from('data') })
  expect(stat).toHaveBeenCalledWith(expect.objectContaining({ workspaceRoot: '/workspace', sessionId: 'session-one' }), 'report.txt', expect.any(AbortSignal))
  readBytes.mockResolvedValueOnce({ absolutePath: '/workspace/report.txt', offset: 0, version: 'two', data: Buffer.from('data'), eof: true })
  await expect(readPresentedFile(ctx as never, 'session-one', 'report.txt', '', 10, new AbortController().signal)).rejects.toThrow('changed')
})

it('delivers explicit files once and ignores other turns and prose paths', () => {
  const projection = new TurnProjection('prompt-one')
  projection.push({ type: 'agent/inbox/spliced', seq: 0, data: { inserted: [{ source: { rpcId: 'prompt-one' } }] } })
  projection.push({ type: 'turn/start', seq: 1, data: { turn: 1 } })
  projection.push({ type: 'deliverables/presented', seq: 2, data: { turn: 2, callId: 'foreign', files: [{ path: '/private/foreign' }] } })
  for (const seq of [3, 4]) projection.push({ type: 'deliverables/presented', seq, data: { turn: 1, callId: 'call', files: [{ path: 'report.txt' }] } })
  projection.push({ type: 'assistant/message', seq: 5, data: { turn: 1, message: { content: [{ type: 'text', text: '/private/not-delivered' }] } } })
  const done = projection.push({ type: 'turn/end', seq: 6, data: { turn: 1, reason: { kind: 'completed' } } })
  expect(done.outcome?.files).toEqual([{ kind: 'presented', path: 'report.txt' }])
})
