import { describe, expect, it } from 'vitest'
import { CodexAdapter } from '../src/adapter.ts'
import { parseModels } from '../src/models.ts'

describe('Codex model picker', () => {
  it('drops hidden and malformed catalog rows and keeps selectable efforts', () => {
    expect(parseModels({
      data: [
        { model: 'hidden-one', hidden: true, displayName: 'Hidden' },
        { displayName: 'missing id' },
        {
          model: 'gpt-5.5',
          displayName: 'GPT-5.5',
          supportedReasoningEfforts: [{ reasoningEffort: 'high', description: 'more' }, { reasoningEffort: 'Not An Effort' }],
          defaultReasoningEffort: 'missing',
        },
      ],
    })).toEqual([{ id: 'gpt-5.5', name: 'GPT-5.5', efforts: [{ id: 'high', description: 'more' }] }])
  })

  it('lists catalog models with efforts and keeps local config as the fallback route', async () => {
    const adapter = new CodexAdapter({} as never, () => '/work', async () => [{
      id: 'gpt-5.5',
      name: 'GPT-5.5',
      efforts: [{ id: 'high', description: 'more' }],
      defaultEffort: 'high',
    }])
    expect((await adapter.listModels('codex')).map(model => model.id)).toEqual(['gpt-5.5', 'native'])
    const resolved = await adapter.resolveModel('codex', 'gpt-5.5')
    expect(resolved.reasoning).toEqual({ efforts: [{ id: 'high', name: 'high', description: 'more' }], defaultEffort: 'high' })
    expect((await adapter.resolveModel('codex', 'native')).reasoning).toBeUndefined()
  })
})
