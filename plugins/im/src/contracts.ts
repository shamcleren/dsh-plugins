import { z } from 'zod'

export const wecomSessionId = z.string().regex(/^session-wecom-[a-zA-Z0-9_-]{1,128}$/u)
export const groupName = z.string().trim().min(1).max(100).regex(/^[^\p{Cc}\p{Cf}]+$/u)
export const sessionSourceSchema = z.object({ group: groupName, speakers: z.array(z.string().min(1).max(256)) }).nullable()
export type SessionSource = z.infer<typeof sessionSourceSchema>

export const capabilitySchema = z.enum(['text', 'image', 'file', 'video', 'approval', 'questions', 'groups', 'notifications'])
export const failureSchema = z.enum(['message-format', 'media', 'host', 'connection'])
export const adapterIdSchema = z.string().regex(/^[a-z][a-z0-9-]{0,47}$/)
export const capabilitiesSchema = z.array(capabilitySchema).max(8).refine(items => new Set(items).size === items.length)
export const adapterStateSchema = z.object({
  enabled: z.boolean(), status: z.enum(['disabled', 'waiting', 'starting', 'running', 'failed']),
  accounts: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
})
export const adapterViewsSchema = z.array(adapterStateSchema.extend({
  id: adapterIdSchema, capabilities: capabilitiesSchema,
  lastFailure: z.object({ kind: failureSchema, at: z.number().int().nonnegative().max(8.64e15) }).optional(),
})).max(16).refine(items => new Set(items.map(item => item.id)).size === items.length)

export type IMCapability = z.infer<typeof capabilitySchema>
export type IMFailure = z.infer<typeof failureSchema>
export type IMAdapterState = z.infer<typeof adapterStateSchema>
export type IMAdapterView = z.infer<typeof adapterViewsSchema>[number]
export interface IMAdapter { id: string; capabilities: readonly IMCapability[]; state(): IMAdapterState }
