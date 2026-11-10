import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-api-workspace-files'
import type {} from '@deepseek-ai/dsh-api-session-controller'
import { SessionId } from '@deepseek-ai/dsh-session'

export interface OutboundFileBytes { name: string; bytes: Buffer }

/** Bound memory even when a stored reference understates its length. */
export async function collectFileBytes(source: AsyncIterable<Uint8Array>, maxBytes: number, signal: AbortSignal): Promise<Buffer> {
  const chunks: Buffer[] = []
  let length = 0
  for await (const chunk of source) {
    signal.throwIfAborted()
    length += chunk.byteLength
    if (length > maxBytes) throw new Error('wechat: outbound file exceeds mediaMaxBytes')
    chunks.push(Buffer.from(chunk))
  }
  signal.throwIfAborted()
  return Buffer.concat(chunks, length)
}

/** Use the public composed filesystem, including its read policy and file-kind gates. */
export async function readPresentedFile(
  ctx: Pick<Context, 'workspaceFiles' | 'sessionController'>,
  sessionId: string, path: string, fallbackRoot: string, maxBytes: number, signal: AbortSignal,
): Promise<OutboundFileBytes> {
  const inspection = await ctx.sessionController.inspect(SessionId(sessionId), signal)
  const scope = { sessionId: SessionId(sessionId), workspaceRoot: inspection.meta.cwd ?? fallbackRoot }
  const before = await ctx.workspaceFiles.stat(scope, path, signal)
  if (before.bytes !== undefined && before.bytes > maxBytes) throw new Error('wechat: outbound file exceeds mediaMaxBytes')
  async function* chunks(): AsyncIterable<Uint8Array> {
    let offset = 0
    while (true) {
      const page = await ctx.workspaceFiles.readBytes(scope, before.absolutePath,
        { range: { offset, length: 64 * 1024 } }, signal)
      if (page.version !== before.version || page.absolutePath !== before.absolutePath || page.offset !== offset) {
        throw new Error('wechat: presented file changed while reading')
      }
      yield page.data
      offset += page.data.byteLength
      if (page.eof) return
      if (page.data.byteLength === 0) throw new Error('wechat: presented file read made no progress')
    }
  }
  const bytes = await collectFileBytes(chunks(), maxBytes, signal)
  const after = await ctx.workspaceFiles.stat(scope, before.absolutePath, signal)
  if (after.version !== before.version || (before.bytes !== undefined && before.bytes !== bytes.length)) {
    throw new Error('wechat: presented file changed while reading')
  }
  return { name: path.split(/[\\/]/u).at(-1) || 'attachment', bytes }
}
