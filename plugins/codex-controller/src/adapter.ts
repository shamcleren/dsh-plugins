/** Codex is a model route. Its tools stay inside Codex and never become DSH tool calls. */
import { LlmAdapter, LlmError, ReasoningEffortId, type GenerateOptions, type LlmModelInfo, type LlmProviderInfo, type LlmResolvedModelInfo, type StreamChunk } from '@deepseek-ai/dsh-llm'
import type { CodexBridge } from './bridge.js'
import { modelById, type CodexModel } from './models.js'
import { localTitle, titleText, turnContent } from './transcript.js'

export const CODEX_PROVIDER = 'codex'
export const NATIVE_MODEL = 'native'

const NATIVE_DESCRIPTION = '沿用本机 Codex 配置中的模型和推理档位'

export class CodexAdapter extends LlmAdapter {
  constructor(private readonly bridge: CodexBridge, private readonly cwdFor: (sessionId: string) => string | undefined, private readonly catalog: () => Promise<readonly CodexModel[]> = async () => []) { super() }

  providerInfo(provider: string): LlmProviderInfo {
    return { id: provider, name: 'Codex' }
  }

  async listModels(provider: string): Promise<readonly LlmModelInfo[]> {
    const models = await this.models()
    const listed = models.map(model => ({
      provider,
      id: model.id,
      name: model.name,
      ...(model.description ? { description: model.description } : {}),
      ...(model.inputModalities ? { inputModalities: model.inputModalities } : {}),
    }))
    return [...listed, { provider, id: NATIVE_MODEL, name: '本机配置', description: NATIVE_DESCRIPTION }]
  }

  async resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    if (model === NATIVE_MODEL) return { provider, id: model, name: '本机配置', description: NATIVE_DESCRIPTION }
    const known = modelById(await this.models(), model)
    const efforts = known?.efforts.map(effort => ({ id: ReasoningEffortId(effort.id), name: effort.id, ...(effort.description ? { description: effort.description } : {}) })) ?? []
    return {
      provider,
      id: model,
      name: known?.name ?? model,
      ...(known?.description ? { description: known.description } : {}),
      ...(efforts.length ? { reasoning: { efforts, ...(known?.defaultEffort ? { defaultEffort: ReasoningEffortId(known.defaultEffort) } : {}) } } : {}),
    }
  }

  async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    if (options.purpose === 'session-title' || options.purpose === 'compaction') {
      const title = options.purpose === 'session-title' ? localTitle(titleText(options.messages)) : 'Codex 会话由 Codex 自己维护上下文。'
      yield* local(title)
      return
    }
    const sessionId = options.sessionId ? String(options.sessionId) : ''
    const cwd = sessionId ? this.cwdFor(sessionId) : undefined
    const content = turnContent(options.messages)
    if (!sessionId || !cwd || (!content.text && !content.images.length)) throw new LlmError('Codex 会话缺少工作区或用户内容', 'INVALID_REQUEST')
    const model = options.model && options.model !== NATIVE_MODEL ? options.model : undefined
    const effort = options.reasoningEffort ? String(options.reasoningEffort) : undefined
    const queue = new ChunkQueue()
    const turn = this.bridge.run({ sessionId, cwd, text: content.text, images: content.images, ...(model ? { model } : {}), ...(effort ? { effort } : {}), signal: options.signal ?? new AbortController().signal, onChunk: chunk => queue.push(chunk) })
    turn.then(() => queue.close(), error => queue.fail(error instanceof LlmError ? error : new LlmError(error instanceof Error ? error.message : String(error), 'CODEX_TURN_FAILED')))
    yield* queue
  }

  private models(): Promise<readonly CodexModel[]> {
    return this.catalog().catch(() => [])
  }
}

class ChunkQueue implements AsyncIterable<StreamChunk> {
  private readonly chunks: StreamChunk[] = []
  private readonly waiting: Array<(result: IteratorResult<StreamChunk>) => void> = []
  private done = false
  private failure: Error | undefined

  push(chunk: StreamChunk): void {
    const next = this.waiting.shift()
    if (next) next({ value: chunk, done: false })
    else this.chunks.push(chunk)
  }

  close(): void { this.finish() }
  fail(error: Error): void { this.failure = error; this.finish() }

  async *[Symbol.asyncIterator](): AsyncIterator<StreamChunk> {
    for (;;) {
      if (this.chunks.length) { yield this.chunks.shift()!; continue }
      if (this.failure) throw this.failure
      if (this.done) return
      const result = await new Promise<IteratorResult<StreamChunk>>(resolve => { this.waiting.push(resolve) })
      if (this.failure) throw this.failure
      if (result.done) return
      yield result.value
    }
  }

  private finish(): void {
    this.done = true
    for (const wait of this.waiting.splice(0)) wait({ value: undefined, done: true })
  }
}

async function* local(text: string): AsyncIterable<StreamChunk> {
  yield { type: 'block-start', index: 0, blockType: 'text' }
  yield { type: 'text-delta', index: 0, text }
  yield { type: 'block-end', index: 0, block: { type: 'text', text } }
  yield { type: 'finish', reason: { kind: 'stop' } }
}
