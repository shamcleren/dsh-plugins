/** Browser-safe configuration and wire contracts. No filesystem or scanner imports. */
import { z } from 'zod'
import { AgentPolicySchema, AgentAuditSchema } from './agent-contract.js'
export const SECURITY_CHANNEL = '/security-scan'
const shortText = z.string().trim().max(2000)
/** Runtime checks target an explicit HTTP(S) service; credentials and fragments never enter stored config. */
export function dynamicTarget(value: string): URL {
  const url = new URL(value)
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.hash) throw new Error('dynamic-url')
  return url
}
const validTarget = (value: string): boolean => { try { dynamicTarget(value); return true } catch { return false } }
export const RepairModeSchema = z.enum(['pr', 'local'])
export const RepairWorkspaceSchema = z.object({ repository: shortText, repositoryUrl: shortText, base: shortText, commit: z.string().regex(/^[a-f0-9]{40,64}$/), branch: shortText, directory: shortText, target: shortText, sourceIdentity: shortText, prUrl: z.string().url().optional() }).strict()
export type RepairWorkspace = z.infer<typeof RepairWorkspaceSchema>
/** 0.17 and earlier pinned one chosen report; that choice now means the task's previous report. */
function legacyBaseline(value: unknown): unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value) || !('baselineId' in value || Reflect.get(value, 'baseline') === 'report')) return value
  const { baselineId: _pinned, ...config } = value as Record<string, unknown>
  return config.baseline === 'report' ? { ...config, baseline: 'previous' } : config
}
export const TaskConfigSchema = z.preprocess(legacyBaseline, z.object({
  name: z.string().trim().min(1).max(100), kind: z.enum(['local', 'remote']), target: shortText.min(1),
  ref: shortText.default(''), scope: z.enum(['full', 'diff', 'staged']),
  /** `previous` compares with the newest report of the same task, resolved when a run is queued. */
  baseline: z.enum(['none', 'git', 'previous']), base: shortText.default(''),
  engine: z.enum(['auto', 'inventory']), dependencies: z.boolean().default(false), secrets: z.boolean().default(false),
  syncSession: z.boolean().default(true), repairMode: RepairModeSchema.default('pr'),
  dynamicUrl: shortText.default(''), dynamicAuthorized: z.boolean().default(false),
  view: z.enum(['all', 'new']).default('all'), autoScan: z.boolean().default(false),
  agent: AgentPolicySchema.default(() => AgentPolicySchema.parse({})),
}).strict().superRefine((value, ctx) => {
  const invalid = (field: string) => ctx.addIssue({ code: 'custom', message: 'Invalid task combination', path: [field] })
  if (value.scope === 'diff' && (value.baseline !== 'git' || !value.base)) invalid('base')
  if (value.baseline === 'git' && !value.base) invalid('base')
  if (value.scope === 'staged' && (value.kind !== 'local' || value.ref || value.baseline !== 'none')) invalid('scope')
  if (value.autoScan && (value.kind !== 'local' || value.ref || value.scope === 'staged')) invalid('autoScan')
  if (value.dynamicUrl && (!validTarget(value.dynamicUrl) || !value.dynamicAuthorized)) invalid('dynamicUrl')
}))
export type TaskConfig = z.infer<typeof TaskConfigSchema>
/** Conversation scans reuse their own task per target; workbench tasks are never rewritten by a conversation. */
export const TaskSchema = z.object({ id: z.string().uuid(), revision: z.number().int().positive(), updatedAt: z.string().datetime(), config: TaskConfigSchema, origin: z.enum(['workbench', 'conversation']).optional() }).strict()
export type Task = z.infer<typeof TaskSchema>
/** Runs from 0.17 and earlier kept their pinned comparison report inside the config; it is the run's baseline. */
function legacyRun(value: unknown): unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value) || 'baselineReportId' in value) return value
  const config: unknown = Reflect.get(value, 'config')
  const pinned = config && typeof config === 'object' && Reflect.get(config, 'baseline') === 'report' ? Reflect.get(config, 'baselineId') : undefined
  return typeof pinned === 'string' && pinned ? { ...value, baselineReportId: pinned } : value
}
export const RunSchema = z.preprocess(legacyRun, z.object({
  id: z.string().uuid(), taskId: z.string().uuid(), config: TaskConfigSchema,
  status: z.enum(['queued', 'running', 'cancelling', 'succeeded', 'partial', 'failed', 'cancelled', 'interrupted']),
  phase: z.enum(['queued', 'preparing', 'scanning', 'baseline', 'dynamic', 'report', 'agent', 'finished']),
  trigger: z.enum(['manual', 'edit', 'conversation', 'repair']), createdAt: z.string().datetime(), finishedAt: z.string().datetime().optional(),
  reportId: z.string().uuid().optional(), rulesReportId: z.string().uuid().optional(), reportRoot: shortText.optional(), error: shortText.optional(),
  previousReportId: z.string().uuid().optional(), previousReportRoot: shortText.optional(),
  /** Report this run compares with when the task baseline is `previous`; absent means a first scan. */
  baselineReportId: z.string().uuid().optional(),
  repairSource: RepairWorkspaceSchema.optional(),
  repair: z.object({ mode: RepairModeSchema.default('local'), workspace: RepairWorkspaceSchema.optional(), admitted: z.boolean().optional(), requestId: z.string().uuid(), sessionId: z.string().max(200), findingIds: z.array(z.string().max(200)).min(1).max(20) }).strict().optional(),
  originSessionId: z.string().max(200).optional(),
  /** Repair conversation that requested this rescan and receives its final notice. */
  repairSessionId: z.string().max(200).optional(),
  sessionId: z.string().max(200).optional(), sessionWarning: z.boolean().optional(),
  diagnostics: z.array(shortText).max(12).optional(),
  findings: z.number().int().nonnegative().optional(),
  coverage: z.enum(['complete', 'partial']).optional(),
  /** `added` is present only when a comparable baseline decided which findings are new. */
  resultSummary: z.object({ confirmed: z.number().int().nonnegative(), pending: z.number().int().nonnegative(), dismissed: z.number().int().nonnegative(), added: z.number().int().nonnegative().optional() }).strict().optional(),
  agent: AgentAuditSchema.optional(),
}).strict())
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
/** A user's decision that one finding is a false positive in one repository. Matching uses stable scanner identity, never report IDs. */
export const SuppressionSchema = z.object({
  id: z.string().uuid(), sourceIdentity: z.string().min(1).max(2000), sourceLabel: z.string().max(2000),
  engine: z.string().min(1).max(100), rule: z.string().min(1).max(200), file: z.string().max(2000), fingerprint: z.string().min(1).max(200),
  title: z.string().max(500), reason: z.string().trim().min(1).max(500), createdAt: z.string().datetime(), reportId: z.string().uuid(),
}).strict()
export type Suppression = z.infer<typeof SuppressionSchema>
export const SuppressRequestSchema = z.object({ id: z.string().uuid(), findingIds: z.array(z.string().min(1).max(200)).min(1).max(100), reason: z.string().trim().min(1).max(500) }).strict()
export const FindingItemSchema = z.object({ category: z.enum(['sourceRisk', 'dependencyRisk', 'secretRisk', 'dynamicRisk']).default('sourceRisk'), id: z.string(), title: z.string(), file: z.string(), line: z.number(), severity: z.enum(['critical', 'high', 'medium', 'low', 'info']), status: z.enum(['confirmed', 'needs-review', 'dismissed']), endpoint: z.string().optional(),
  /** Excluded by the user, either when this report was written or afterwards. */
  suppressed: z.boolean().default(false),
  /** AI-only findings have no stable fingerprint across scans, so they cannot be excluded. */
  suppressible: z.boolean().default(false) })
export const ReportActionsSchema = z.object({
  findings: z.array(FindingItemSchema), run: RunSchema.optional(), repairable: z.boolean(),
  repairMode: RepairModeSchema.default('pr'), prPreview: z.object({ repositoryUrl: shortText, base: shortText, commit: shortText, revision: z.string().regex(/^[a-f0-9]{64}$/) }).optional(), prError: shortText.optional(),
  comparison: z.object({ previousId: z.string(), comparable: z.boolean(), items: z.array(FindingItemSchema.extend({ change: z.enum(['remaining', 'notObserved', 'added', 'unverified']) })) }).optional(),
  /** Present when this report is a rescan inside a repair chain whose session can take a follow-up round. */
  repairChain: z.object({ sessionId: z.string().max(200), round: z.number().int().positive() }).strict().optional(),
})
export type ReportActions = z.infer<typeof ReportActionsSchema>
export const RepairRequestSchema = z.object({ id: z.string().uuid(), findingIds: z.array(z.string().min(1).max(200)).min(1).max(20), mode: RepairModeSchema, expectedRevision: z.string().regex(/^[a-f0-9]{40,64}$/).optional() }).strict()
export type UiRemote = {
  reportActions(id: string): Promise<ReportActions>
  repair(id: string, findingIds: string[], mode: 'pr' | 'local', expectedRevision?: string): Promise<{ sessionId: string }>
  continueRepair(id: string): Promise<{ sessionId: string; count: number }>
  rescan(id: string): Promise<Run>
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
  suppress(id: string, findingIds: string[], reason: string): Promise<{ added: number; existing: number }>
  suppressions(): Promise<Suppression[]>
  unsuppress(id: string): Promise<void>
}
export const newTask = (): TaskConfig => ({ name: '', kind: 'local', target: '', ref: '', scope: 'full', baseline: 'previous', base: '', engine: 'auto', dependencies: true, secrets: true, view: 'all', autoScan: false, syncSession: true, repairMode: 'pr', dynamicUrl: '', dynamicAuthorized: false, agent: AgentPolicySchema.parse({ enabled: true }) })
