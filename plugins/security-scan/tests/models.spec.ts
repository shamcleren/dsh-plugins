import { expect, it, vi } from 'vitest'
import { listAuditModels } from '../src/models.js'
import { modelChoices } from '../src/client/ModelPicker.js'

it('uses public display names, preserves route identity, and never returns provider internals', async () => {
  const llm = {
    listProviders: () => [{ id: 'route/one', name: 'Work', apiKey: 'fixture-secret' }, { id: 'route-two', name: 'Personal' }],
    listModels: vi.fn(async (provider: string) => [{ provider, id: 'same-model', name: 'Friendly model', headers: { authorization: 'fixture-secret' } }]),
  }
  expect(await listAuditModels(llm)).toEqual({ models: [
    { provider: 'route/one', providerName: 'Work', model: 'same-model', name: 'Friendly model' },
    { provider: 'route-two', providerName: 'Personal', model: 'same-model', name: 'Friendly model' },
  ], partial: false })
  expect(llm.listModels).toHaveBeenCalledTimes(2)
})

it('keeps healthy providers when one catalog fails and distinguishes an empty catalog', async () => {
  expect(await listAuditModels({ listProviders: () => [], listModels: vi.fn() })).toEqual({ models: [], partial: false })
  const result = await listAuditModels({ listProviders: () => [{ id: 'bad', name: 'Bad' }, { id: 'good', name: 'Good' }], listModels: async provider => {
    if (provider === 'bad') throw new Error('private upstream details')
    return [{ provider, id: 'm', name: 'Model' }]
  } })
  expect(result).toEqual({ models: [{ provider: 'good', providerName: 'Good', model: 'm', name: 'Model' }], partial: true })
})

it('preserves unlisted saved models and avoids confusing identical IDs on different providers', () => {
  const models = [{ provider: 'a', providerName: 'A', model: 'm', name: 'M' }, { provider: 'b', providerName: 'B', model: 'm', name: 'M' }]
  expect(modelChoices(models, { provider: '', model: '' })).toEqual(models)
  expect(modelChoices(models, { provider: 'b', model: 'm' })).toEqual(models)
  expect(modelChoices([], { provider: 'legacy', model: 'unlisted' })).toEqual([{ provider: 'legacy', model: 'unlisted', providerName: 'legacy', name: 'unlisted', saved: true }])
  expect(modelChoices([...models, models[0]!], { provider: '', model: '' })).toEqual(models)
})
