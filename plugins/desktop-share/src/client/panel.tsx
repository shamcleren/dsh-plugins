import { useState, type CSSProperties } from 'react'
import { createPortal } from 'react-dom'
import type { SharedBatch } from './transport.js'
import type { LocaleKey } from './locales.js'

/** Pin to the window, not `shell.overlay`: that layer is a full-frame absolute box whose
 *  static children start at the title-bar origin (traffic lights / top-left). */
export const panelPlacement = {
  position: 'fixed',
  top: 60,
  right: 16,
  left: 'auto',
  zIndex: 100,
} satisfies CSSProperties

export interface DraftChoice { id: string; name: string; status?: 'uploading' | 'ready' | 'error' | undefined }
export interface PanelProps {
  t: (key: LocaleKey) => string
  pending: SharedBatch[]
  drafts: DraftChoice[]
  currentTitle?: string | undefined
  busy: boolean
  locked: boolean
  notice: string
  onAdd: (batch: SharedBatch) => void
  onDismiss: (batch: SharedBatch) => void
  onRemove: (id: string) => void
  onRetry: (id: string) => void
  onRefresh: () => void
  onReveal: () => void
  onClearNotice: () => void
}

export function SharePanel(p: PanelProps) {
  const { t } = p
  const [collapsed, collapse] = useState(false)
  return createPortal(<section className="dsh-share" style={panelPlacement} aria-label={t('title')} aria-busy={p.busy}>
    <header><button type="button" className="dsh-share-heading" onClick={() => collapse(!collapsed)} aria-expanded={!collapsed}>{t('title')} <span>{p.pending.length + p.drafts.length}</span> {collapsed ? '▸' : '▾'}</button><button type="button" className="dsh-share-tool" title={t('folder')} aria-label={t('folder')} onClick={p.onReveal}>↗</button></header>
    {!collapsed && <div className="dsh-share-body">
      {p.pending.map(batch => <div className="dsh-share-row" key={batch.id}>
        <button type="button" className="dsh-share-add" disabled={p.busy || p.locked} title={`${batch.files.map(f => f.name).join(', ')}${p.currentTitle ? ` → ${p.currentTitle}` : ''}`} onClick={() => p.onAdd(batch)}>
          <span className="dsh-share-name">{batch.files.map(f => f.name).join(', ')}</span>
          <small>{t(p.busy ? 'adding' : p.locked ? (p.currentTitle ? 'busy' : 'openSession') : 'add')}</small>
        </button>
        <button type="button" className="dsh-share-remove" disabled={p.busy} title={t('dismissHint')} aria-label={`${t('dismiss')} ${batch.files.map(f => f.name).join(', ')}`} onClick={() => p.onDismiss(batch)}>×</button>
      </div>)}
      {p.drafts.map(file => <div className="dsh-share-row" key={file.id}>
        <div className="dsh-share-file"><span className="dsh-share-name" title={file.name}>{file.name}</span><small>{t(file.status === 'uploading' ? 'uploading' : file.status === 'error' ? 'uploadError' : 'inDraft')}</small></div>
        {file.status === 'error' && <button type="button" className="dsh-share-tool" disabled={p.busy || p.locked} onClick={() => p.onRetry(file.id)}>{t('retry')}</button>}
        <button type="button" className="dsh-share-remove" title={t('remove')} aria-label={`${t('remove')} ${file.name}`} disabled={p.busy || p.locked} onClick={() => p.onRemove(file.id)}>×</button>
      </div>)}
      {p.notice && <div className="dsh-share-notice" role="status"><span>{p.notice}</span><button type="button" className="dsh-share-tool" onClick={p.onRefresh}>{t('retry')}</button><button type="button" className="dsh-share-remove" onClick={p.onClearNotice} aria-label={t('close')}>×</button></div>}
    </div>}
  </section>, document.body)
}

export const panelCSS = `
.dsh-share{--share-line:#e5e7eb;--share-bg:#fff;--share-soft:#f6f7f9;--share-text:#252a34;--share-muted:#727985;position:fixed;top:60px;right:16px;left:auto;z-index:100;width:min(300px,calc(100vw - 32px));color:var(--share-text);background:var(--share-bg);border:1px solid var(--share-line);border-radius:12px;font:12px/1.45 -apple-system,BlinkMacSystemFont,sans-serif;overflow:hidden;text-align:left;box-shadow:0 4px 18px #00000012}
body[data-ds-dark-theme] .dsh-share{--share-line:#35383e;--share-bg:#202226;--share-soft:#292c31;--share-text:#e5e7eb;--share-muted:#a1a8b5}
.dsh-share *{box-sizing:border-box}.dsh-share button{font:inherit;cursor:pointer;border:0;background:none;color:inherit;line-height:1.45}.dsh-share button:disabled{cursor:default;opacity:.5}.dsh-share button:focus-visible{outline:2px solid #4b76f8;outline-offset:-2px}.dsh-share button:hover:not(:disabled){background:var(--share-soft)}
.dsh-share header{display:flex;align-items:center;justify-content:space-between;padding:5px 8px 3px 10px}.dsh-share-heading{padding:2px 0;font-weight:500!important;color:var(--share-muted)!important}.dsh-share-heading span{font-size:10px;margin:0 4px}.dsh-share .dsh-share-tool{padding:3px 5px;color:var(--share-muted);font-size:11px;border-radius:5px}.dsh-share-body{max-height:min(230px,40vh);overflow-y:auto;padding:0 5px 5px}.dsh-share-row{display:flex;align-items:center;gap:4px;border-radius:7px}.dsh-share-add,.dsh-share-file{display:flex;flex-direction:column;align-items:flex-start;min-width:0;flex:1;text-align:left;padding:6px 7px;border-radius:7px}.dsh-share-name{display:block;max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.dsh-share small{font-size:10px;color:var(--share-muted);margin-top:2px}.dsh-share-add small{color:#4775ee}.dsh-share .dsh-share-remove{font-size:18px;color:var(--share-muted);width:25px;height:25px;flex-shrink:0;border-radius:6px;padding:0}.dsh-share-notice{display:flex;align-items:center;gap:4px;padding:5px 7px;font-size:11px;color:var(--share-muted)}.dsh-share-notice>span{flex:1}
`
