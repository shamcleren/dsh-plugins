import { z } from 'zod'

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
