import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-agent-presets'
import type {} from '@deepseek-ai/dsh-api-session-controller'
import type { SessionRequestId } from '@deepseek-ai/dsh-api-session-controller/types'
import { SessionId } from '@deepseek-ai/dsh-session'
import { WorkspaceId, type Workspace } from '@deepseek-ai/dsh-workspace'
import type { AskUserQuestionAnswer } from '@deepseek-ai/dsh-user-questions'
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
/** Minimal same-process Host API used by the channel plugin. */

export interface RpcRequest<T> {
  rpcId: string
  payload: T
}

export type RpcResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: { code: string; message: string } }

export interface RpcResponse<T> {
  rpcId: string
  result: RpcResult<T>
}

export interface HostSessionEvent {
  type: string
  seq: number
  data: unknown
}

export interface SessionEventFrame {
  type: 'session/event'
  sessionId: string
  event: HostSessionEvent
}

export interface AskUserQuestionOption {
  label: string
  description?: string
}

export interface AskUserQuestionItem {
  id: string
  question: string
  detail?: string
  header?: string
  options?: AskUserQuestionOption[]
  multiSelect?: boolean
}

export interface AskUserQuestionAnswerItem {
  id: string
  selected: string[]
  custom?: string
}

export interface QuestionRequestedFrame {
  type: 'question/requested'
  sessionId: string
  questions: AskUserQuestionItem[]
}

export interface QuestionResolvedFrame {
  type: 'question/resolved'
  sessionId: string
  questionRpcId: string
  outcome: 'answered' | 'cancelled'
}

export type HostMuxFrame = SessionEventFrame | QuestionRequestedFrame | QuestionResolvedFrame
  | { type: string; sessionId?: string }

export interface ClientResponse {
  type: 'client-response'
  rpcId: string
  result: RpcResult<unknown>
}

export type RpcReceipt = { accepted: true }
  | { accepted: false; reason: 'not-pending' | 'bad-response' }

export interface HistoryEntry {
  event: HostSessionEvent
}

export type PromptContentPart =
  | { type: 'text'; text: string }
  | { type: 'image'; mediaType: 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif'; data: string; name?: string }

/** Agent preset row projected for channel command output. */
export interface HostPreset {
  id: string
  name?: string
  description?: string
  /** Why this preset cannot compose a session, absent when it can. */
  broken?: string
}

/** Host Workspace projection used for channel routing and command output. */
export interface HostWorkspace {
  workspaceId: string
  path: string
  title: string
  sessionIds: string[]
}

export interface HostApiProxy {
  workspace: {
    list(request: RpcRequest<Record<string, never>>): Promise<RpcResponse<{
      items: HostWorkspace[]
      archivedSessionIds: string[]
    }>>
    create(request: RpcRequest<{ path: string }>): Promise<RpcResponse<{
      workspace: HostWorkspace
      created: boolean
    }>>
    rename(request: RpcRequest<{ workspaceId: string; title: string }>): Promise<RpcResponse<{
      workspace: HostWorkspace
    }>>
  }
  presets: {
    list(request: RpcRequest<Record<string, never>>): Promise<RpcResponse<{
      items: HostPreset[]
      defaultId: string
    }>>
  }
  sessions: {
    create(request: RpcRequest<{
      sessionId: string
      workspaceId?: string
      agentPreset?: string
    }>): Promise<RpcResponse<{ sessionId: string; agentPreset?: string }>>
    history(request: RpcRequest<{
      sessionId: string
      beforeSeq?: number
      maxMessages?: number
    }>): Promise<RpcResponse<{ events: HistoryEntry[]; hasMore: boolean }>>
    prompt(request: RpcRequest<{
      sessionId: string
      mode: 'queue' | 'steer'
      content: PromptContentPart[]
    }>): Promise<RpcResponse<{
      accepted: true
      command?: { kind: 'success'; text?: string }
    }>>
    models(request: RpcRequest<{ sessionId: string }>): Promise<RpcResponse<{
      current: { provider: string; model: string; reasoningEffort?: string }
      groups: Array<{
        id: string
        name: string
        models: Array<{
          id: string
          name: string
          reasoning?: { efforts: Array<{ id: string; name: string }>; defaultEffort?: string }
        }>
      }>
    }>>
    selectModel(request: RpcRequest<{
      sessionId: string
      provider: string
      model: string
      reasoningEffort?: string
    }>): Promise<RpcResponse<{
      selected: { provider: string; model: string; reasoningEffort?: string }
    }>>
  }
  events: {
    mux(request: RpcRequest<Record<string, never>>, signal: AbortSignal):
    AsyncIterable<RpcRequest<HostMuxFrame>>
  }
  respond(message: ClientResponse): Promise<RpcReceipt>
}

/** Host business error retaining its stable RPC code for recovery decisions. */
export class HostApiError extends Error {
  constructor(readonly code: string, message: string) {
    super(`${code}: ${message}`)
    this.name = 'HostApiError'
  }
}

/** Return a successful unary value or raise the Host's business error. */
export function unwrap<T>(response: RpcResponse<T>): T {
  if (response.result.ok) return response.result.value
  throw new HostApiError(response.result.error.code, response.result.error.message)
}

/**
 * Submit through upstream queue/steer and report the channel's reply ownership.
 * A rejected steer may be queued once when the previous turn ended before admission.
 */
export async function submitChannelPrompt(
  api: HostApiProxy,
  request: Parameters<HostApiProxy['sessions']['prompt']>[0],
) {
  let mode = request.payload.mode
  let response = await api.sessions.prompt(request)
  if (mode === 'steer' && !response.result.ok && response.result.error.code === 'agent-busy') {
    mode = 'queue'
    response = await api.sessions.prompt({ ...request, payload: { ...request.payload, mode } })
  }
  if (!response.result.ok) return { rpcId: response.rpcId, result: response.result }
  return { ...response, result: { ok: true as const, value: {
    ...response.result.value, disposition: mode === 'steer' ? 'next-step' as const : 'next-turn' as const,
  } } }
}

/** Translate this channel's local transport contract onto the public DSH controllers. */
export function createHostApi(ctx: Context, routesSession: (sessionId: string) => boolean): HostApiProxy {
  const controller = ctx.sessionController, registry = ctx.workspaceRegistry
  const lifetime = new AbortController()
  const listeners = new Set<(frame: RpcRequest<HostMuxFrame>) => void>()
  const pending = new Map<string, (answer: AskUserQuestionAnswer) => void>()
  const emit = (payload: HostMuxFrame, rpcId = randomUUID()) => { for (const listener of listeners) listener({ rpcId, payload }) }
  ctx.effect(() => () => lifetime.abort())
  ctx.on('session/event', (session, event) => { if (routesSession(session.id)) emit({ type: 'session/event', sessionId: session.id, event }) })
  // Agent-scoped question dispatch filters sibling plugin fibers; claim
  // owned turns even when this plugin is not inside the agent scope.
  ctx.on('user-questions/request', async (request, next) => {
    const sessionId = request.agent?.id
    if (!sessionId || !routesSession(sessionId) || listeners.size === 0) return next()
    const rpcId = randomUUID(), signal = AbortSignal.any([lifetime.signal, ...(request.signal ? [request.signal] : [])])
    signal.throwIfAborted()
    return new Promise<AskUserQuestionAnswer>((resolve, reject) => {
      const finish = (outcome: 'answered' | 'cancelled') => { pending.delete(rpcId); signal.removeEventListener('abort', cancel); emit({ type: 'question/resolved', sessionId, questionRpcId: rpcId, outcome }) }
      const cancel = () => { finish('cancelled'); reject(signal.reason) }
      pending.set(rpcId, answer => { finish('answered'); resolve(answer) })
      signal.addEventListener('abort', cancel, { once: true })
      emit({ type: 'question/requested', sessionId, questions: request.questions }, rpcId)
    })
  }, { global: true })
  const response = async <T>(request: RpcRequest<unknown>, operation: () => Promise<T>): Promise<RpcResponse<T>> => {
    try { lifetime.signal.throwIfAborted(); return { rpcId: request.rpcId, result: { ok: true, value: await operation() } } }
    catch (error) { return { rpcId: request.rpcId, result: { ok: false, error: { code: error instanceof Error && 'code' in error ? String(error.code) : 'host-error', message: error instanceof Error ? error.message : 'Host operation failed' } } } }
  }
  const workspace = (item: Workspace): HostWorkspace => ({ workspaceId: item.id, path: item.path, title: item.title, sessionIds: [...item.sessionIds] })
  return {
    workspace: {
      list: request => response(request, async () => ({ items: registry.list().map(workspace), archivedSessionIds: [...registry.archivedSessionIds] })),
      create: request => response(request, async () => { const previous = registry.list(); const item = await registry.create(request.payload.path); return { workspace: workspace(item), created: !previous.some(old => old.id === item.id) } }),
      rename: request => response(request, async () => { const item = registry.get(WorkspaceId(request.payload.workspaceId)); if (!item) throw new Error('workspace-not-found'); await item.setTitle(request.payload.title); return { workspace: workspace(item) } }),
    },
    presets: {
      list: request => response(request, async () => {
        // The preset registry is optional in a deployment; the session controller
        // itself only treats it as an optional service. A channel that cannot read
        // the roster still routes turns on whatever preset its settings name.
        const presets = ctx.get('agentPresets')
        if (presets === undefined) throw Object.assign(new Error('this deployment has no agent preset registry'), { code: 'presets-unavailable' })
        return { items: (await presets.list()).map(preset => ({ id: preset.id, ...(preset.name === undefined ? {} : { name: preset.name }), ...(preset.description === undefined ? {} : { description: preset.description }), ...(preset.broken === undefined ? {} : { broken: preset.broken }) })), defaultId: presets.defaultId }
      }),
    },
    sessions: {
      create: request => response(request, async () => { const { sessionId, workspaceId, agentPreset } = request.payload; const result = await controller.create({ sessionId: SessionId(sessionId), ...(workspaceId ? { workspaceId: WorkspaceId(workspaceId) } : {}), ...(agentPreset ? { agentPreset } : {}) }); return result }),
      history: request => response(request, async () => { const history = await controller.inspect(SessionId(request.payload.sessionId), lifetime.signal); const before = request.payload.beforeSeq ?? Infinity; const events = history.events.filter(event => event.seq < before); const count = Math.max(1, Math.min(1000, request.payload.maxMessages ?? 100)); return { events: events.slice(-count).map(event => ({ event })), hasMore: events.length > count } }),
      prompt: request => response(request, async () => { return controller.prompt({ ...request.payload, sessionId: SessionId(request.payload.sessionId), requestId: request.rpcId as SessionRequestId }, lifetime.signal) }),
      models: request => response(request, async () => {
        const catalog = await controller.modelCatalog(), resolved = await controller.resolveAgent(SessionId(request.payload.sessionId))
        if ('error' in resolved) throw new Error('session-unavailable')
        const options = resolved.agent.options
        return { current: { provider: options.provider ?? catalog.default.provider, model: options.model ?? catalog.default.model, ...(options.reasoningEffort ? { reasoningEffort: options.reasoningEffort } : {}) }, groups: catalog.groups.map(group => ({ ...group, models: group.models.map(model => ({ id: model.id, name: model.name, ...(model.reasoning ? { reasoning: { ...model.reasoning, efforts: [...model.reasoning.efforts] } } : {}) })) })) }
      }),
      selectModel: request => response(request, () => controller.selectModel({ ...request.payload, sessionId: SessionId(request.payload.sessionId) })),
    },
    events: {
      async *mux(_request, callerSignal) {
        const signal = AbortSignal.any([lifetime.signal, callerSignal]), queue: RpcRequest<HostMuxFrame>[] = []
        let wake: (() => void) | undefined, overflow = false
        const receive = (frame: RpcRequest<HostMuxFrame>) => { if (queue.length >= 2048) overflow = true; else queue.push(frame); wake?.() }
        const abort = () => wake?.()
        listeners.add(receive); signal.addEventListener('abort', abort, { once: true })
        try { while (!signal.aborted) { if (overflow) throw new Error('Channel event consumer is too slow'); const frame = queue.shift(); if (frame) yield frame; else await new Promise<void>(resolve => { wake = resolve }) } }
        finally { listeners.delete(receive); signal.removeEventListener('abort', abort) }
      },
    },
    async respond(message) {
      const resolve = pending.get(message.rpcId)
      if (!resolve) return { accepted: false, reason: 'not-pending' }
      if (!message.result.ok) return { accepted: false, reason: 'bad-response' }
      const parsed = z.object({ answer: z.object({ answers: z.array(z.object({ id: z.string(), selected: z.array(z.string()), custom: z.string().optional() })) }) }).safeParse(message.result.value)
      if (!parsed.success) return { accepted: false, reason: 'bad-response' }
      resolve({ answers: parsed.data.answer.answers.map(answer => ({ id: answer.id, selected: answer.selected, ...(answer.custom === undefined ? {} : { custom: answer.custom }) })) })
      return { accepted: true }
    },
  }
}
