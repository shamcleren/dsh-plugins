/** Shared configuration and audit metadata; safe to import in the browser. */
import { z } from 'zod'

export const AgentPolicySchema = z.object({
  enabled: z.boolean().default(false),
  provider: z.string().trim().max(200).default(''),
  model: z.string().trim().max(200).default(''),
  // Kept only to read old task snapshots; native execution does not use these limits.
  maxSteps: z.number().int().min(3).max(40).optional(),
  maxMinutes: z.number().int().min(1).max(30).optional(),
  maxTokens: z.number().int().min(1024).max(16384).optional(),
}).strict().refine(value => !value.enabled || Boolean(value.provider) === Boolean(value.model), 'Provider and model must be selected together')
export type AgentPolicy = z.infer<typeof AgentPolicySchema>
export const ReviewAreaSchema = z.enum(['entry-points', 'authentication', 'authorization', 'injection', 'data-exposure', 'business-logic'])
export const AgentEventSchema = z.object({
  step: z.number().int().nonnegative(),
  kind: z.enum(['planning', 'listing', 'reading', 'reviewing', 'rejected', 'finished']),
  files: z.array(z.string().max(2000)).max(10).default([]),
  code: z.string().regex(/^[a-z-]{1,80}$/u).optional(),
  count: z.number().int().nonnegative().default(0),
}).strict()
export const AgentAuditSchema = z.object({
  status: z.enum(['completed', 'incomplete']),
  reason: z.enum(['completed', 'step-limit', 'time-limit', 'context-limit', 'output-limit', 'model-unavailable', 'preset-unavailable', 'model-failed', 'invalid-response', 'evidence-unavailable', 'cancelled']),
  preset: z.string().max(200).optional(),
  nativeEnd: z.string().max(80).optional(),
  nativeErrorCode: z.string().max(100).optional(),
  provider: z.string().max(200), model: z.string().max(200),
  steps: z.number().int().nonnegative(),
  areas: z.array(ReviewAreaSchema).max(6),
  files: z.array(z.string().max(2000)).max(5000),
  eligibleCandidates: z.number().int().nonnegative().optional(),
  excludedCandidates: z.number().int().nonnegative().optional(),
  reviewedFindings: z.number().int().nonnegative(),
  additionalFindings: z.number().int().nonnegative().default(0),
  inputTokens: z.number().nonnegative(), outputTokens: z.number().nonnegative(),
  cacheReadTokens: z.number().nonnegative().default(0), cacheWriteTokens: z.number().nonnegative().default(0),
  usageAvailable: z.boolean(),
  events: z.array(AgentEventSchema).max(200),
}).strict()
export type AgentAudit = z.infer<typeof AgentAuditSchema>

export function formatTokenCount(value: number): string {
  if (!Number.isFinite(value) || value < 0) return '0'
  const compact = (unit: number, suffix: string): string => (value / unit).toFixed(1).replace(/\.0$/u, '') + suffix
  if (value >= 1_000_000) return compact(1_000_000, 'M')
  if (value >= 1000) return compact(1000, 'K')
  return String(Math.round(value))
}

export function cacheHitPercent(inputTokens: number, cacheReadTokens: number): number | undefined {
  if (!(inputTokens > 0 && cacheReadTokens > 0)) return
  return Math.min(100, Math.round((100 * cacheReadTokens) / inputTokens))
}

/** Compact usage for lists: `24.1M tok · 缓存命中 98%`. Omits cache when the provider did not report reads. */
export function formatAgentUsage(audit: Pick<AgentAudit, 'usageAvailable' | 'inputTokens' | 'outputTokens' | 'cacheReadTokens'>, cacheHitLabel: string): string | undefined {
  if (!audit.usageAvailable) return
  const total = formatTokenCount(audit.inputTokens + audit.outputTokens) + ' tok'
  const hit = cacheHitPercent(audit.inputTokens, audit.cacheReadTokens)
  return hit === undefined ? total : total + ' · ' + cacheHitLabel + ' ' + hit + '%'
}

/** Official tools inherited by the audit executor from its preset. */
export const BASIC_AUDIT_TOOLS = ['bash', 'pwsh', 'read', 'write', 'edit', 'glob', 'grep', 'skill', 'job_output', 'job_list', 'job_kill'] as const
