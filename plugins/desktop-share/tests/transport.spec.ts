import { describe, expect, it } from 'vitest'
import { parseBatches, receiveFiles, type SharedBatch, type ShareTransport } from '../src/client/transport.js'

const batch: SharedBatch = { id: 'AC16B89F-3F3D-413C-B9E9-4C87554A0551', files: [{ id: 'A52A56BB-2DBF-4E08-8FCF-82264217A22E', name: '微信聊天.zip', size: 150_000 }] }
describe('desktop share boundary', () => {
  it('reconstructs exact bytes over several bounded native replies without acknowledging', async () => {
    const bytes = Uint8Array.from({ length: 150_000 }, (_, index) => index % 251)
    const actions: string[] = []
    const transport: ShareTransport = { async postMessage(body) {
      actions.push(String(body.action)); expect(body.batch).toBe(batch.id); expect(body.file).toBe(batch.files[0]!.id)
      const offset = body.offset as number
      return Buffer.from(bytes.slice(offset, offset + 65_536)).toString('base64')
    } }
    const files = await receiveFiles(transport, parseBatches([batch])[0]!, new AbortController().signal)
    expect(files[0]!.name).toBe('微信聊天.zip'); expect(files[0]!.type).toBe('application/zip')
    expect(new Uint8Array(await files[0]!.arrayBuffer())).toEqual(bytes)
    expect(actions).toEqual(['read', 'read', 'read'])
  })
  it('stops on session switch without reading more chunks', async () => {
    const abort = new AbortController()
    let calls = 0
    await expect(receiveFiles({ async postMessage() { calls++; abort.abort(); return '' } }, batch, abort.signal)).rejects.toThrow()
    expect(calls).toBe(1)
  })
  it('rejects truncated and oversized replies without returning partial files', async () => {
    for (const reply of ['', 'AA==', 'A'.repeat(87_385)]) {
      await expect(receiveFiles({ async postMessage() { return reply } }, batch, new AbortController().signal)).rejects.toThrow()
    }
  })
  it('rejects traversal identities, oversized batches and malformed metadata', () => {
    for (const value of [null, [{ ...batch, id: '../secret' }], [{ ...batch, files: [{ ...batch.files[0], size: -1 }] }], [{ ...batch, files: [{ ...batch.files[0], size: 51 * 1024 * 1024 }] }], [{ ...batch, files: [...batch.files, ...batch.files] }]]) expect(() => parseBatches(value)).toThrow()
  })
  it('preserves empty files and identifies shared images', async () => {
    const files = await receiveFiles({ postMessage() { throw new Error('No read for an empty file') } }, { ...batch, files: [{ ...batch.files[0]!, name: 'picture.png', size: 0 }] }, new AbortController().signal)
    expect(files[0]!.size).toBe(0); expect(files[0]!.type).toBe('image/png')
  })
})
