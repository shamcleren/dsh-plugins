/** Browser-safe configuration and wire contracts. No filesystem or scanner imports. */
import { z } from 'zod'
import { AgentPolicySchema, AgentAuditSchema } from './agent-contract.js'
export const SECURITY_CHANNEL = '/security-scan'
const shortText = z.string().trim().max(2000)
export const TaskConfigSchema = z.object({
  name: z.string().trim().min(1).max(100), kind: z.enum(['local', 'remote']), target: shortText.min(1),
  ref: shortText.default(''), scope: z.enum(['full', 'diff', 'staged']),
  baseline: z.enum(['none', 'git', 'report']), base: shortText.default(''), baselineId: z.union([z.literal(''), z.string().uuid()]).default(''),
  engine: z.enum(['auto', 'inventory']), dependencies: z.boolean().default(false), secrets: z.boolean().default(false),
  syncSession: z.boolean().default(true),
  view: z.enum(['all', 'new']).default('all'), autoScan: z.boolean().default(false),
  agent: AgentPolicySchema.default(() => AgentPolicySchema.parse({})),
}).strict().superRefine((value, ctx) => {
  const invalid = (field: string) => ctx.addIssue({ code: 'custom', message: 'Invalid task combination', path: [field] })
  if (value.scope === 'diff' && (value.baseline !== 'git' || !value.base)) invalid('base')
  if (value.baseline === 'git' && !value.base) invalid('base')
  if (value.baseline === 'report' && !value.baselineId) invalid('baselineId')
  if (value.scope === 'staged' && (value.kind !== 'local' || value.ref || value.baseline !== 'none')) invalid('scope')
  if (value.autoScan && (value.kind !== 'local' || value.ref || value.scope === 'staged')) invalid('autoScan')
})
export type TaskConfig = z.infer<typeof TaskConfigSchema>
export const TaskSchema = z.object({ id: z.string().uuid(), revision: z.number().int().positive(), updatedAt: z.string().datetime(), config: TaskConfigSchema }).strict()
export type Task = z.infer<typeof TaskSchema>
export const RunSchema = z.object({
  id: z.string().uuid(), taskId: z.string().uuid(), config: TaskConfigSchema,
  status: z.enum(['queued', 'running', 'cancelling', 'succeeded', 'partial', 'failed', 'cancelled', 'interrupted']),
  phase: z.enum(['queued', 'preparing', 'scanning', 'baseline', 'report', 'agent', 'finished']),
  trigger: z.enum(['manual', 'edit', 'conversation']), createdAt: z.string().datetime(), finishedAt: z.string().datetime().optional(),
  reportId: z.string().uuid().optional(), rulesReportId: z.string().uuid().optional(), reportRoot: shortText.optional(), error: shortText.optional(),
  originSessionId: z.string().max(200).optional(),
  sessionId: z.string().max(200).optional(), sessionWarning: z.boolean().optional(),
  diagnostics: z.array(shortText).max(12).optional(),
  findings: z.number().int().nonnegative().optional(),
  coverage: z.enum(['complete', 'partial']).optional(),
  resultSummary: z.object({ confirmed: z.number().int().nonnegative(), pending: z.number().int().nonnegative(), dismissed: z.number().int().nonnegative() }).strict().optional(),
  agent: AgentAuditSchema.optional(),
}).strict()
export type Run = z.infer<typeof RunSchema>
export const SettingsSchema = z.object({
  semgrepPath: shortText.min(1), gitleaksPath: shortText.min(1), reportDirectory: shortText.min(1),
  autoScan: z.boolean(), hookTools: z.array(z.string().trim().min(1).max(100)).max(30),
}).strict()
export type ScanSettings = z.infer<typeof SettingsSchema>
export const ReportItemSchema = z.object({
  id: z.string().uuid(), createdAt: z.string(), source: z.string(), scope: z.string(), findings: z.number(), json: z.string(), html: z.string(),
  agent: z.object({
    model: z.string().max(400), usageAvailable: z.boolean(),
    inputTokens: z.number().nonnegative(), outputTokens: z.number().nonnegative(), cacheReadTokens: z.number().nonnegative(),
  }).strict().optional(),
})
export type ReportItem = z.infer<typeof ReportItemSchema>
export const ToolchainStateSchema = z.object({ status: z.enum(['idle', 'installing', 'ready', 'failed']), phase: z.enum(['idle', 'checking', 'download', 'python', 'semgrep', 'gitleaks', 'ready']), semgrep: z.string(), gitleaks: z.string(), error: z.string() })
export type ToolchainState = z.infer<typeof ToolchainStateSchema>
export const ModelOptionSchema = z.object({ provider: z.string().min(1), providerName: z.string(), model: z.string().min(1), name: z.string() })
export const ModelCatalogSchema = z.object({ models: z.array(ModelOptionSchema), partial: z.boolean() })
export type ModelCatalog = z.infer<typeof ModelCatalogSchema>
export type ModelOption = z.infer<typeof ModelOptionSchema>
export const UiStateSchema = z.object({ tasks: z.array(TaskSchema), runs: z.array(RunSchema), reports: z.array(ReportItemSchema), settings: SettingsSchema, settingsWritable: z.boolean(), toolchains: ToolchainStateSchema.optional(), agentDefault: z.object({ provider: z.string(), model: z.string() }).nullable().default(null), warnings: z.array(z.string()).default([]) })
export type UiState = z.infer<typeof UiStateSchema>
export const HookRequestSchema = z.object({ taskId: z.string().uuid(), revision: z.number().int().positive(), event: z.enum(['pre-commit', 'pre-push']), action: z.enum(['install', 'remove']), enforce: z.boolean(), base: shortText.default(''), confirm: z.literal(true) }).strict()
export type HookRequest = z.infer<typeof HookRequestSchema>
export type UiRemote = {
  models(): Promise<ModelCatalog>
  state(): Promise<UiState>
  setup(): Promise<void>
  save(config: TaskConfig, id?: string, revision?: number): Promise<Task>
  remove(id: string, revision: number): Promise<void>
  removeRun(id: string): Promise<void>
  removeReport(id: string): Promise<void>
  run(id: string, revision: number): Promise<Run>
  cancel(id: string): Promise<void>
  settings(value: ScanSettings): Promise<void>
  hook(request: HookRequest): Promise<void>
  source(id: string, file: string, line: number): Promise<{ content: string }>
  report(id: string, format: 'html' | 'json'): Promise<string>
}
export const newTask = (): TaskConfig => ({ name: '', kind: 'local', target: '', ref: '', scope: 'full', baseline: 'none', base: '', baselineId: '', engine: 'auto', dependencies: true, secrets: true, view: 'all', autoScan: false, syncSession: true, agent: AgentPolicySchema.parse({ enabled: true }) })
