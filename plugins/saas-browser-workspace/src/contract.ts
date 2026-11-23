import { z } from 'zod'

export const CHANNEL = '/saas-workspace'
export const TOOL = 'saas_query_agents'
export const PROVIDER = 'saas-playwright'
export const PREFIX = `mcp__${PROVIDER}__`
export const Id = z.string().uuid()
export const Session = z.string().min(1).max(200)
export const Fields = z.object({ keyword: z.string().trim().max(120), view: z.enum(['table', 'list']).default('table') }).strict()
export type Fields = z.infer<typeof Fields>
export const Row = z.object({
  key: z.string().max(100), name: z.string().min(1).max(500), type: z.string().max(200),
  version: z.string().max(200), tags: z.array(z.string().max(200)).max(20), description: z.string().max(2000),
}).strict()
export type Row = z.infer<typeof Row>
export const Observation = z.object({
  id: Id, capturedAt: z.string().datetime(), url: z.string().url().max(2000), title: z.string().max(300),
  rows: z.array(Row).max(50), renderedCount: z.number().int().min(0), truncated: z.boolean(),
  coverage: z.literal('rendered-results'), evidenceId: Id, counts: z.record(z.string(), z.number().int().nonnegative()),
}).strict()
export type Observation = z.infer<typeof Observation>
export const Run = z.object({
  id: Id, sessionId: Session, revision: z.number().int().positive(), siteName: z.string().max(100),
  status: z.enum(['awaiting_input', 'queued', 'running', 'awaiting_login', 'succeeded', 'partial', 'failed', 'cancelled', 'interrupted']),
  createdAt: z.string().datetime(), updatedAt: z.string().datetime(),
  input: z.object({ id: Id, fields: Fields, requestId: Id.optional(), submitted: z.boolean(), accepted: z.boolean() }).strict(),
  observation: Observation.optional(), error: z.string().max(100).optional(),
}).strict()
export type Run = z.infer<typeof Run>
export const NavigationBlock = z.object({ origin: z.string().url().max(512), at: z.string().datetime() }).strict()
export const State = z.object({ configured: z.boolean(), siteName: z.string(), run: Run.nullable(), blockedOrigin: z.string().url().max(512).optional() }).strict()
export type State = z.infer<typeof State>
export const BoundRequest = z.object({ sessionId: Session, runId: Id, revision: z.number().int().positive() }).strict()
export const SubmitRequest = BoundRequest.extend({ inputId: Id, fields: Fields }).strict()
export type SubmitRequest = z.infer<typeof SubmitRequest>
export type BoundRequest = z.infer<typeof BoundRequest>
export interface Remote {
  state(sessionId: string, signal?: AbortSignal): Promise<State>
  submit(request: SubmitRequest): Promise<Run>
  edit(request: BoundRequest): Promise<Run>
  resume(request: BoundRequest, signal?: AbortSignal): Promise<Run>
  showLogin(request: BoundRequest, signal?: AbortSignal): Promise<Run>
  cancel(request: BoundRequest): Promise<Run>
  evidence(sessionId: string, runId: string, evidenceId: string, signal?: AbortSignal): Promise<Blob>
}
export class WorkspaceError extends Error {
  constructor(readonly code: string) { super(code) }
}
