import type { Context } from '@deepseek-ai/cordis'
import type { Agent, ModelSelectionRef } from '@deepseek-ai/dsh-agent'
import { ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { BotModel } from './config.js'
import { z } from 'zod'

const selectionSchema = z.object({ provider: z.string().min(1), model: z.string().min(1), reasoningEffort: z.string().min(1).optional() })

/** Use public Agent waterfalls without persisting the deployment-wide model default. */
export class ConversationModels {
  private readonly selections = new Map<string, { agent: Agent; ref: ModelSelectionRef; dispose(): void }>()

  constructor(private readonly ctx: Context) {
    ctx.on('session/event', (session, event) => {
      if (event.type !== 'model/selection') return
      const entry = this.selections.get(session.id), selected = selectionSchema.safeParse(event.data)
      if (entry !== undefined && selected.success) entry.ref.current = {
        provider: selected.data.provider, model: selected.data.model,
        ...selected.data.reasoningEffort === undefined ? {} : { reasoningEffort: ReasoningEffortId(selected.data.reasoningEffort) },
      }
    }, { global: true })
    ctx.effect(() => () => {
      for (const entry of this.selections.values()) entry.dispose()
      this.selections.clear()
    })
  }

  current(id: string): BotModel | undefined { return this.selections.get(id)?.ref.current }

  /** Read the durable choice after restart without changing it or creating an Agent. */
  async describe(id: string): Promise<BotModel | undefined> {
    const live = this.current(id)
    if (live !== undefined) return live
    const inspection = await this.ctx.sessionController.inspect(SessionId(id))
    for (const event of [...inspection.events].reverse()) {
      const parsed = selectionSchema.safeParse(event.type === 'model/selection' ? event.data
        : event.type === 'request/header' ? event.data.header.config : undefined)
      if (parsed.success) return { provider: parsed.data.provider, model: parsed.data.model,
        ...parsed.data.reasoningEffort === undefined ? {} : { reasoningEffort: parsed.data.reasoningEffort } }
    }
    return undefined
  }

  async select(id: string, requested: BotModel): Promise<BotModel> {
    const resolved = await this.ctx.sessionController.resolveAgent(SessionId(id))
    if ('error' in resolved) throw resolved.error
    const agent = resolved.agent
    const catalog = await this.ctx.sessionController.modelCatalog()
    const model = catalog.groups.find(group => group.id === requested.provider)?.models.find(model => model.id === requested.model)
    if (model === undefined || (requested.reasoningEffort !== undefined
      && !model.reasoning?.efforts.some(effort => effort.id === requested.reasoningEffort))) {
      throw new Error('wecom-aibot: requested model or reasoning effort is unavailable')
    }
    const selected = await this.ctx.llm.resolveCallConfig({
      provider: requested.provider, model: requested.model,
      ...requested.reasoningEffort === undefined ? {} : { reasoningEffort: ReasoningEffortId(requested.reasoningEffort) },
    })
    let entry = this.selections.get(id)
    if (entry?.agent !== agent) {
      entry?.dispose()
      const ref: ModelSelectionRef = { current: undefined, assembled: undefined }
      // Prepend makes this explicit channel choice wrap the Host default selector.
      const assembly = agent.ctx.on('system-prompt/assemble', async (_assembly, _context, next) => {
        const selected = ref.current
        const value = await next()
        ref.assembled = selected
        return selected === undefined ? value : { ...value,
          variables: { ...value.variables, provider: selected.provider, model: selected.model } }
      }, { prepend: true })
      const request = agent.ctx.on('agent/request', async (_payload, next) => {
        const value = await next(), selected = ref.assembled
        if (selected === undefined) return value
        const { reasoningEffort: _inherited, ...rest } = value
        return { ...rest, ...selected }
      }, { prepend: true })
      entry = { agent, ref, dispose: () => { assembly(); request() } }
      this.selections.set(id, entry)
      agent.ctx.effect(() => () => {
        const current = this.selections.get(id)
        if (current?.agent !== agent) return
        current.dispose()
        this.selections.delete(id)
      })
    }
    const choice = { provider: selected.provider, model: selected.model,
      ...selected.reasoningEffort === undefined ? {} : { reasoningEffort: selected.reasoningEffort } }
    agent.session.append('model/selection', choice)
    entry.ref.current = choice
    return choice
  }
}
