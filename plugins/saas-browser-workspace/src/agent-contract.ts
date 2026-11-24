import { z } from 'zod'
import type { LiveFrame, LiveSurface } from './live-protocol.js'

export const AGENT_CHANNEL = '/saas-agent'
export const BROWSER_TOOL = 'saas_browser'
export const VIEW_TOOL = 'saas_present'
export const ASK_TOOL = 'saas_ask'
export const AgentSession = z.string().min(1).max(200)
export const Control = z.object({ ref: z.string(), label: z.string(), role: z.string(), value: z.string(), canFill: z.boolean(), canClick: z.boolean(), sensitive: z.boolean(), purpose: z.enum(['search', 'message', 'submit', 'navigation', 'disclosure', 'readonly']).default('readonly'), approval: z.array(z.enum(['click', 'fill', 'select'])).optional(), options: z.array(z.object({ label: z.string(), value: z.string() })).optional() })
export type Control = z.infer<typeof Control>
export const AgentRecord = z.object({ id: z.string(), name: z.string(), type: z.string(), version: z.string(), description: z.string(), tags: z.array(z.string()), actions: z.array(z.object({ ref: z.string(), label: z.string() })) })
export type AgentRecord = z.infer<typeof AgentRecord>
export const PageField = z.object({
  label: z.string(), kind: z.enum(['text', 'multiline', 'choice', 'toggle', 'number']),
  state: z.enum(['value', 'empty', 'unread', 'redacted']), value: z.string(),
  checked: z.enum(['on', 'off', 'mixed']).optional(),
})
export type PageField = z.infer<typeof PageField>
export const PageBlock = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('fields'), title: z.string(), fields: z.array(PageField) }),
  z.object({ kind: z.literal('table'), title: z.string(), columns: z.array(z.string()), rows: z.array(z.array(z.string())) }),
  z.object({ kind: z.literal('list'), title: z.string(), items: z.array(z.string()) }),
  z.object({ kind: z.literal('text'), title: z.string(), text: z.string() }),
])
export type PageBlock = z.infer<typeof PageBlock>
export const PageDocument = z.object({
  blocks: z.array(PageBlock),
  gaps: z.array(z.object({ kind: z.enum(['collapsed', 'graphic', 'embedded', 'editor', 'unread', 'unstructured', 'limit']), label: z.string() })),
  truncated: z.boolean(),
})
export type PageDocument = z.infer<typeof PageDocument>
export const PageObservation = z.object({ id: z.string().uuid(), url: z.string(), title: z.string(), text: z.string(), controls: z.array(Control), records: z.array(AgentRecord), document: PageDocument.optional(), capturedAt: z.string(), truncated: z.boolean(), recordsState: z.enum(['unavailable', 'loading', 'ready', 'empty']).default('unavailable') })
export type PageObservation = z.infer<typeof PageObservation>
export const Question = z.object({ id: z.string().uuid(), title: z.string().min(1).max(300), fields: z.array(z.object({ name: z.string().regex(/^[a-z][a-z0-9_]{0,39}$/), label: z.string().min(1).max(100), required: z.boolean().default(true), type: z.enum(['text', 'textarea']).default('text') })).min(1).max(6) }).refine(question => new Set(question.fields.map(field => field.name)).size === question.fields.length, 'Field names must be unique')
export type Question = z.infer<typeof Question>
export const ExecutionResult = z.object({
  id: z.string(), mode: z.enum(['debug', 'use']), status: z.enum(['running', 'completed', 'failed', 'uncertain']),
  input: z.string(), output: z.string(), error: z.string().optional(), url: z.string(), startedAt: z.string(), updatedAt: z.string(),
})
export type ExecutionResult = z.infer<typeof ExecutionResult>
export const ActionReview = z.object({
  id: z.string().uuid(),
  action: z.enum(['click', 'fill', 'select']),
  label: z.string(),
  url: z.string(),
  pageTitle: z.string(),
  expiresAt: z.string(),
  before: z.string().optional(),
  after: z.string().optional(),
  fields: z.array(PageField).max(24),
  fieldsLimited: z.boolean(),
  target: z.object({ left: z.number(), top: z.number(), width: z.number(), height: z.number() }),
})
export type ActionReview = z.infer<typeof ActionReview>
export const AgentState = z.object({
  sessionId: AgentSession, configured: z.boolean(), siteName: z.string(), phase: z.enum(['ready', 'queued', 'working', 'awaiting_input', 'awaiting_approval', 'human', 'failed']),
  operation: z.string(), view: z.enum(['table', 'list', 'summary', 'details', 'results']).default('table'), title: z.string(),
  executionEnabled: z.boolean().default(false), executions: z.array(ExecutionResult).default([]),
  observation: PageObservation.optional(), listing: PageObservation.optional(), details: PageObservation.optional(), selected: AgentRecord.optional(), executionModes: z.array(z.enum(['debug', 'use'])).default([]), question: Question.optional(), selectedId: z.string().optional(),
  review: ActionReview.optional(), approvalEnabled: z.boolean().optional(),
  humanReason: z.enum(['login', 'requested']).optional(), blockedOrigin: z.string().optional(), error: z.string().optional(),
  agentRunning: z.boolean().default(false), browserReady: z.boolean(), revision: z.number().int(),
  generation: z.string().uuid().optional(),
})
export type AgentState = z.infer<typeof AgentState>
export function latestAgentState(previous: AgentState | undefined, next: AgentState): AgentState {
  return previous && previous.sessionId === next.sessionId && previous.generation === next.generation && previous.revision >= next.revision ? previous : next
}
export const BrowserArgs = z.object({ action: z.enum(['open', 'observe', 'fill', 'select', 'press', 'click', 'submit', 'wait', 'back', 'scroll']), url: z.string().url().max(2000).optional(), observation_id: z.string().uuid().optional(), ref: z.string().max(30).optional(), text: z.string().max(2000).optional(), request_id: z.string().regex(/^[a-zA-Z0-9_-]{1,80}$/).optional(), delta: z.number().int().min(-1200).max(1200).optional() }).strict()
export type BrowserArgs = z.infer<typeof BrowserArgs>
export const HumanInput = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('click'), x: z.number().min(0).max(1600), y: z.number().min(0).max(1200) }).strict(),
  z.object({ kind: z.literal('text'), text: z.string().max(1000) }).strict(),
  z.object({ kind: z.literal('key'), key: z.enum(['Enter', 'Tab', 'Backspace', 'Delete', 'Escape', 'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End', 'ControlOrMeta+A']) }).strict(),
  z.object({ kind: z.literal('scroll'), delta: z.number().int().min(-1200).max(1200), deltaX: z.number().int().min(-1200).max(1200).optional(),
    x: z.number().min(0).max(1600).optional(), y: z.number().min(0).max(1200).optional() }).strict(),
])
export type HumanInput = z.infer<typeof HumanInput>
export interface AgentRemote {
  state(sessionId: string, signal?: AbortSignal): Promise<AgentState>
  call(method: string, payload: unknown, signal?: AbortSignal): Promise<unknown>
  frame(sessionId: string, signal: AbortSignal, approvalId?: string): Promise<Blob>
  live(sessionId: string, signal: AbortSignal, receive: (packet: LiveSurface | LiveFrame) => void): Promise<void>
}
