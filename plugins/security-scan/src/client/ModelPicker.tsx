import { useEffect, useState } from 'react'
import type { ModelCatalog, ModelOption, UiRemote } from '../ui-contract.js'
import type { LocaleKey } from './locales.js'
type Selection = { provider: string; model: string }
const key = (value: Selection): string => JSON.stringify([value.provider, value.model])
export function modelChoices(models: ModelOption[], selected: Selection): Array<ModelOption & { saved?: boolean }> {
  const choices = [...new Map(models.map(model => [key(model), model])).values()]
  return selected.provider && !choices.some(model => key(model) === key(selected))
    ? [...choices, { ...selected, name: selected.model, providerName: selected.provider, saved: true }]
    : choices
}
export function ModelPicker({ remote, value, defaultModel, onChange, t }: {
  remote: Pick<UiRemote, 'models'>; value: Selection; defaultModel?: Selection | null;
  onChange(value: Selection): void; t(key: LocaleKey): string
}) {
  const [catalog, setCatalog] = useState<ModelCatalog>({ models: [], partial: false })
  const [revision, refresh] = useState(0), [loading, setLoading] = useState(true)
  useEffect(() => {
    let disposed = false
    setLoading(true)
    void remote.models().then(result => { if (!disposed) setCatalog(result) })
      .catch(() => { if (!disposed) setCatalog(current => ({ ...current, partial: true })) })
      .finally(() => { if (!disposed) setLoading(false) })
    return () => { disposed = true }
  }, [remote, revision])
  const choices = modelChoices(catalog.models, value)
  const defaultName = defaultModel ? catalog.models.find(model => key(model) === key(defaultModel)) : undefined
  const defaultLabel = defaultModel ? (defaultName ? defaultName.name + ' · ' + defaultName.providerName : defaultModel.model) : t('agentModelMissing')
  return <div className="model-picker">
    <label className="field"><span>{t('agentAdvanced')}</span><select value={value.provider ? key(value) : ''} onChange={event => {
      const choice = choices.find(model => key(model) === event.target.value)
      if (choice) onChange({ provider: choice.provider, model: choice.model })
      else if (!event.target.value) onChange({ provider: '', model: '' })
    }}><option value="">{t('agentDefault')} · {defaultLabel}</option>{choices.map(model => <option key={key(model)} value={key(model)}>
      {model.name}{model.name !== model.model ? ' (' + model.model + ')' : ''} · {model.providerName}{model.saved ? ' · ' + t('agentSavedModel') : ''}
    </option>)}</select></label>
    <button type="button" disabled={loading} onClick={() => refresh(value => value + 1)}>{t(loading ? 'agentModelsLoading' : 'agentModelsRefresh')}</button>
    <p className="muted" role="status">{t(loading ? 'agentModelsLoading' : catalog.partial ? 'agentModelsFailed' : catalog.models.length ? 'agentModelsHint' : 'agentModelsEmpty')}</p>
    {choices.some(model => model.saved) && !loading ? <p className="muted">{t('agentSavedModelHint')}</p> : null}
  </div>
}
