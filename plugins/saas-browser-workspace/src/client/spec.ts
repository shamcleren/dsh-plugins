import type { GenuiSpec } from '@changfenhuang/dsh-genui/embed'
import type { Run, Observation } from '../contract.js'
import type { Translate } from '../locales.js'

// GenUI supports inline Markdown; website values remain plain text in these views.
export const plain = (value: string): string => value.replace(/[\\`*_{}[\]<>#|]/gu, '\\$&')
export function formSpec(run: Run, t: Translate): GenuiSpec {
  return { items: [
    { type: 'input', id: 'keyword', label: t('keyword'), placeholder: t('keywordHint'), value: run.input.fields.keyword },
    { type: 'select', id: 'view', label: t('display'), options: [t('table'), t('list')], selected: run.input.fields.view === 'table' ? 0 : 1 },
    { type: 'submit', action: 'submit-query', label: t('submit'), groups: ['view'] },
  ] }
}
export function resultSpec(observation: Observation, view: 'table' | 'list' | 'summary', t: Translate): GenuiSpec {
  if (view === 'summary') return { items: [
    { type: 'stat', label: t('loaded'), value: String(observation.rows.length), size: 'hero' },
    ...Object.entries(observation.counts).map(([type, count]) => ({ type: 'progress' as const, label: plain(type), value: observation.rows.length ? count * 100 / observation.rows.length : 0, valueLabel: String(count) })),
  ] }
  if (!observation.rows.length) return { items: [{ type: 'text', content: t('noResults') }] }
  if (view === 'list') return { items: [{ type: 'list', items: observation.rows.map(row => ({
    title: plain(row.name), desc: plain([row.type, row.version, row.tags.join(' / '), row.description].filter(Boolean).join(' · ')),
  })) }] }
  return { items: [{ type: 'table', columns: [t('name'), t('type'), t('version'), t('tags'), t('descriptionField')], wrap: true,
    rows: observation.rows.map(row => [row.name, row.type, row.version, row.tags.join(' / '), row.description].map(plain)) }] }
}
