import { Service, type Context } from '@deepseek-ai/cordis'
import { adapterIdSchema, adapterStateSchema, capabilitiesSchema, failureSchema, type IMAdapter, type IMAdapterState, type IMAdapterView, type IMFailure } from './contracts.js'
export type { IMAdapter, IMAdapterState, IMAdapterView, IMCapability, IMFailure } from './contracts.js'
declare module '@deepseek-ai/cordis' { interface Context { imHub: IMHub } }

/** Platform registration is public; account transports and their secrets remain adapter-owned. */
export class IMHub extends Service {
  private readonly adapters = new Map<string, IMAdapter>()
  private readonly failures = new Map<string, { kind: IMFailure; at: number }>()
  constructor(ctx: Context) {
    super(ctx, 'imHub')
    ctx.effect(() => () => { this.adapters.clear(); this.failures.clear() }, 'IM adapter registry')
  }
  register(adapter: IMAdapter): () => void {
    const id = adapterIdSchema.parse(adapter.id), capabilities = Object.freeze(capabilitiesSchema.parse(adapter.capabilities))
    if (this.adapters.has(id) || this.adapters.size >= 16 || typeof adapter.state !== 'function') throw new Error('Invalid or duplicate IM adapter')
    const owned = { id, capabilities, state: adapter.state.bind(adapter) }
    this.adapters.set(id, owned)
    return () => { if (this.adapters.get(id) === owned) { this.adapters.delete(id); this.failures.delete(id) } }
  }
  report(id: string, kind: IMFailure): void { if (this.adapters.has(id)) this.failures.set(id, { kind: failureSchema.parse(kind), at: Date.now() }) }
  state(): IMAdapterView[] {
    return [...this.adapters.values()].map(adapter => {
      let state: IMAdapterState
      try { state = adapterStateSchema.parse(adapter.state()) }
      catch { state = { enabled: true, status: 'failed', accounts: 0 } }
      const lastFailure = this.failures.get(adapter.id)
      return { id: adapter.id, capabilities: [...adapter.capabilities], ...state, ...(lastFailure ? { lastFailure: { ...lastFailure } } : {}) }
    })
  }
}
