import { useState } from 'react'
import type { ReactNode } from 'react'
import type { PageObservation, PageField } from '../agent-contract.js'
import type { AgentTranslate } from '../agent-locales.js'

function FieldValue({ field, t }: { field: PageField; t: AgentTranslate }) {
  if (field.state !== 'value') return <span className="saas-field-status">{t(field.state === 'empty' ? 'emptyValue' : field.state)}</span>
  if (field.checked) return <span className={'saas-field-check ' + field.checked}>{t(field.kind === 'choice' ? field.checked === 'on' ? 'optionSelected' : 'optionUnselected' : field.checked)}</span>
  return <span>{field.value}</span>
}

/** A fixed vocabulary of React elements: page data is never executable HTML. */
export function PageContent({ observation, t, current, preview, openBrowser }: {
  observation: PageObservation; t: AgentTranslate; current: boolean; preview: ReactNode; openBrowser: () => void
}) {
  const doc = observation.document
  const [mode, setMode] = useState<'structure' | 'original'>(doc?.blocks.length ? 'structure' : 'original')
  return <div className="saas-page-content">
    <h3>{observation.title || t('details')}</h3>
    <div className="saas-page-modes" role="group" aria-label={t('pageMode')}>
      <button aria-pressed={mode === 'structure'} onClick={() => setMode('structure')}>{t('structure')}</button>
      <button aria-pressed={mode === 'original'} onClick={() => setMode('original')}>{t('original')}</button>
    </div>
    <p className="saas-agent-caption">{t('pageScope')}</p>
    {mode === 'original' ? <div className="saas-page-preview">
      <p className="saas-agent-caption">{t(current ? 'currentImage' : 'differentPage')}</p>
      {current && preview}
      <button onClick={openBrowser}>{t('expandOriginal')} ↗</button>
    </div> : <>
      {!!doc?.gaps.length && <div className="saas-page-gaps" role="note"><strong>{t('partialPage')}</strong><ul>{doc.gaps.map((gap, index) => <li key={index}>{t(gap.kind === 'limit' ? 'truncated' : gap.kind === 'unread' ? 'unread' : gap.kind)}{gap.label && <> · {gap.label}</>}</li>)}</ul><button onClick={() => setMode('original')}>{t('original')}</button></div>}
      {doc?.blocks.map((block, index) => <section className="saas-page-block" key={index}>
        <h4>{block.title || t(block.kind === 'fields' ? 'fields' : block.kind === 'text' ? 'content' : block.kind)}</h4>
        {block.kind === 'fields' && <dl>{block.fields.map((field, i) => <div key={i}><dt>{field.label || t(field.state === 'redacted' ? 'privateField' : 'unnamedField')}</dt><dd><FieldValue field={field} t={t} /></dd></div>)}</dl>}
        {block.kind === 'text' && <p className="saas-page-text">{block.text}</p>}
        {block.kind === 'list' && <ul>{block.items.map((item, i) => <li key={i}>{item}</li>)}</ul>}
        {block.kind === 'table' && <div className="saas-agent-table" role="region" aria-label={block.title || t('table')} tabIndex={0}><table>{!!block.columns.length && <thead><tr>{block.columns.map((column, i) => <th key={i}>{column}</th>)}</tr></thead>}<tbody>{block.rows.map((row, i) => <tr key={i}>{row.map((cell, j) => <td key={j}>{cell}</td>)}</tr>)}</tbody></table></div>}
      </section>)}
      {!doc?.blocks.length && <p>{t('unstructured')}</p>}
    </>}
    {!!observation.text && <details className="saas-page-transcript"><summary>{t('plainText')}</summary><pre>{observation.text}</pre></details>}
  </div>
}
