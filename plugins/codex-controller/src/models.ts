/** Advisory Codex model catalog. The picker reads this; thread start still accepts an unlisted id. */
import { createInterface } from 'node:readline'
import { homedir } from 'node:os'
import { codexArgv } from './binary.js'
import type { CodexSpawn } from './connection.js'

export interface CodexModel {
  id: string
  name: string
  description?: string
  efforts: ReadonlyArray<{ id: string; description?: string }>
  defaultEffort?: string
  inputModalities?: ReadonlyArray<'text' | 'image'>
}

const TTL_MS = 60_000
let cached: { at: number; models: readonly CodexModel[] } | undefined
let pending: Promise<readonly CodexModel[]> | undefined

export function listCodexModels(spawn: CodexSpawn, now = Date.now()): Promise<readonly CodexModel[]> {
  if (cached && now - cached.at < TTL_MS) return Promise.resolve(cached.models)
  if (pending) return pending
  pending = probe(spawn).then(models => {
    cached = { at: Date.now(), models }
    return models
  }).finally(() => { pending = undefined })
  return pending
}

export function modelById(models: readonly CodexModel[], id: string): CodexModel | undefined {
  return models.find(model => model.id === id)
}

async function probe(spawn: CodexSpawn): Promise<readonly CodexModel[]> {
  const child = spawn({ argv: codexArgv(), cwd: homedir(), graceMs: 3000 })
  if (!child.stdout || !child.stdin) {
    child.terminate()
    return []
  }
  child.stderr?.resume()
  const lines = createInterface({ input: child.stdout })
  const waiting = new Map<number, (frame: { result?: unknown; error?: { message?: string } }) => void>()
  let next = 1
  lines.on('line', line => {
    try {
      const frame = JSON.parse(line) as { id?: number; result?: unknown; error?: { message?: string } }
      if (typeof frame.id !== 'number') return
      waiting.get(frame.id)?.(frame)
      waiting.delete(frame.id)
    } catch { /* ignore a non-JSON diagnostic line */ }
  })
  const request = (method: string, params: object): Promise<{ result?: unknown; error?: { message?: string } }> => new Promise((resolve, reject) => {
    const id = next++
    const timer = setTimeout(() => { waiting.delete(id); reject(new Error('codex-controller: model catalog timed out')) }, 8000)
    waiting.set(id, frame => { clearTimeout(timer); resolve(frame) })
    child.stdin?.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n')
  })
  try {
    const initialized = await request('initialize', { clientInfo: { name: 'dsh-codex-controller', title: 'DSH Codex Controller', version: '0.3.0' }, capabilities: { experimentalApi: false } })
    if (initialized.error) return []
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'initialized', params: {} }) + '\n')
    const listed = await request('model/list', {})
    if (listed.error) return []
    return parseModels(listed.result)
  } catch {
    return []
  } finally {
    lines.close()
    try { child.stdin.end() } catch { /* already closed */ }
    child.terminate()
    await child.waitForExit(AbortSignal.timeout(3000)).catch(() => false)
  }
}

export function parseModels(value: unknown): CodexModel[] {
  const data = isRecord(value) && Array.isArray(value.data) ? value.data : []
  const models: CodexModel[] = []
  for (const item of data) {
    if (!isRecord(item) || item.hidden === true || typeof item.model !== 'string' || !item.model) continue
    const efforts = Array.isArray(item.supportedReasoningEfforts) ? item.supportedReasoningEfforts.flatMap(effort) : []
    const modalities = Array.isArray(item.inputModalities) ? item.inputModalities.filter((mode): mode is 'text' | 'image' => mode === 'text' || mode === 'image') : []
    const defaultEffort = typeof item.defaultReasoningEffort === 'string' && efforts.some(entry => entry.id === item.defaultReasoningEffort) ? item.defaultReasoningEffort : undefined
    models.push({
      id: item.model,
      name: typeof item.displayName === 'string' && item.displayName ? item.displayName : item.model,
      ...(typeof item.description === 'string' && item.description ? { description: item.description } : {}),
      efforts,
      ...(defaultEffort ? { defaultEffort } : {}),
      ...(modalities.length ? { inputModalities: modalities } : {}),
    })
  }
  return models
}

function effort(value: unknown): Array<{ id: string; description?: string }> {
  if (!isRecord(value) || typeof value.reasoningEffort !== 'string' || !/^[a-z0-9_-]{1,32}$/.test(value.reasoningEffort)) return []
  return [{ id: value.reasoningEffort, ...(typeof value.description === 'string' && value.description ? { description: value.description } : {}) }]
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}
