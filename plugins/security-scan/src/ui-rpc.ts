import type { ConnectionRpcHandler } from '@deepseek-ai/dsh-client-connection'
import { z } from 'zod'
import type { SecurityTasks } from './tasks.js'
import { TaskError } from './tasks.js'
import { HookRequestSchema, SettingsSchema, TaskConfigSchema } from './ui-contract.js'
const empty = z.object({}).strict()
const id = z.object({ id: z.string().uuid() }).strict()
const task = id.extend({ revision: z.number().int().positive() })
/** Human-facing mutations use the public loopback Connection channel, not model tools. */
export function createSecurityRpc(ready: Promise<SecurityTasks>, log: (error: unknown) => void): ConnectionRpcHandler {
  return async (endpoint, payload, signal) => {
    try {
      const service = await ready
      let value: unknown
      switch (endpoint) {
        case 'setup': empty.parse(payload); service.setup(); value = null; break
        case 'models': empty.parse(payload); value = await service.models(); break
        case 'state': empty.parse(payload); value = await service.state(); break
        case 'save': { const request = z.object({ config: TaskConfigSchema, id: z.string().uuid().optional(), revision: z.number().int().positive().optional() }).strict().parse(payload); value = await service.save(request.config, request.id, request.revision); break }
        case 'remove': { const request = task.parse(payload); await service.remove(request.id, request.revision); value = null; break }
        case 'removeRun': await service.removeRun(id.parse(payload).id); value = null; break
        case 'removeReport': await service.removeReport(id.parse(payload).id); value = null; break
        case 'run': { const request = task.parse(payload); value = await service.start(request.id, request.revision); break }
        case 'cancel': await service.cancel(id.parse(payload).id); value = null; break
        case 'settings': await service.settings(SettingsSchema.parse(payload)); value = null; break
        case 'hook': await service.hook(HookRequestSchema.parse(payload)); value = null; break
        case 'source': { const request = id.extend({ file: z.string().max(2000), line: z.number().int().positive() }).strict().parse(payload); value = await service.source(request.id, request.file, request.line, signal); break }
        case 'report': { const request = id.extend({ format: z.enum(['html', 'json']) }).parse(payload); value = await service.report(request.id, request.format); break }
        default: throw new TaskError('unknown-operation')
      }
      return { ok: true, value }
    } catch (error) {
      const code = error instanceof TaskError ? error.code : error instanceof z.ZodError ? 'invalid-input' : 'operation-failed'
      log(new TaskError(code))
      return { ok: false, error: { code: 'bad-request', message: code, details: { issues: [] } } }
    }
  }
}
