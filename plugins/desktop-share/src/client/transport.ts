export interface SharedFile { id: string; name: string; size: number }
export interface SharedBatch { id: string; files: SharedFile[] }
export interface ShareTransport { postMessage(body: Record<string, unknown>): Promise<unknown> }
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const maxBytes = 50 * 1024 * 1024

export function parseBatches(value: unknown): SharedBatch[] {
  if (!Array.isArray(value) || value.length > 100) throw new Error('invalid-share')
  return value.map((batch: unknown) => {
    if (!batch || typeof batch !== 'object' || !('id' in batch) || typeof batch.id !== 'string' || !uuid.test(batch.id) || !('files' in batch) || !Array.isArray(batch.files) || !batch.files.length || batch.files.length > 20) throw new Error('invalid-share')
    const files = batch.files.map((file: unknown): SharedFile => {
      if (!file || typeof file !== 'object' || !('id' in file) || typeof file.id !== 'string' || !uuid.test(file.id) || !('name' in file) || typeof file.name !== 'string' || !file.name || file.name.length > 1024 || !('size' in file) || typeof file.size !== 'number' || !Number.isSafeInteger(file.size) || file.size < 0 || file.size > maxBytes) throw new Error('invalid-share')
      return { id: file.id, name: file.name, size: file.size }
    })
    if (files.reduce((sum, file) => sum + file.size, 0) > maxBytes || new Set(files.map(f => f.id)).size !== files.length) throw new Error('invalid-share')
    return { id: batch.id, files }
  })
}

/** Stream bounded bridge replies; no file path is ever accepted from the page. */
export async function receiveFiles(transport: ShareTransport, batch: SharedBatch, signal: AbortSignal): Promise<File[]> {
  const files: File[] = []
  for (const file of batch.files) {
    const chunks: Uint8Array<ArrayBuffer>[] = []
    let offset = 0
    while (offset < file.size) {
      signal.throwIfAborted()
      const encoded = await transport.postMessage({ action: 'read', batch: batch.id, file: file.id, offset })
      signal.throwIfAborted()
      if (typeof encoded !== 'string' || encoded.length > 87_384) throw new Error('invalid-share-chunk')
      const raw = atob(encoded)
      if (raw.length !== Math.min(65_536, file.size - offset)) throw new Error('invalid-share-chunk')
      chunks.push(Uint8Array.from(raw, char => char.charCodeAt(0)))
      offset += raw.length
    }
    const extension = file.name.split('.').at(-1)?.toLowerCase()
    const mime: Record<string, string> = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', zip: 'application/zip', txt: 'text/plain' }
    files.push(new File(chunks, file.name, { type: mime[extension ?? ''] ?? 'application/octet-stream' }))
  }
  signal.throwIfAborted()
  return files
}
