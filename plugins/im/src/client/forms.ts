import type { CSSProperties } from 'react'

const input: CSSProperties = {
  boxSizing: 'border-box', width: '100%', minWidth: 0, height: 40, minHeight: 40,
  appearance: 'none', WebkitAppearance: 'none', padding: '9px 12px', lineHeight: '20px',
  border: '1px solid var(--imw-line)', borderRadius: 8, backgroundColor: 'transparent', color: 'inherit', fontSize: 13,
}
export const styles: Record<'form' | 'section' | 'sectionHeading' | 'hiddenLabel' | 'badge' | 'mutedBadge' | 'field' | 'fieldHead' | 'label' | 'input' | 'select' | 'hint' | 'error' | 'reset' | 'toggle' | 'qr' | 'loginActions' | 'footer' | 'button' | 'save' | 'disabled', CSSProperties> = {
  form: { display: 'grid', gap: 16, minWidth: 0 },
  section: { display: 'flex', flexDirection: 'column', gap: 12, minWidth: 0, padding: 20, border: '1px solid var(--imw-line)', borderRadius: 12 },
  sectionHeading: { flex: 1, margin: 0, fontSize: 14, fontWeight: 600, lineHeight: 1.5, color: 'inherit' },
  hiddenLabel: { position: 'absolute', width: 1, height: 1, overflow: 'hidden', clip: 'rect(0 0 0 0)' },
  badge: { borderRadius: 6, padding: '3px 8px', fontSize: 11, lineHeight: '18px', background: 'var(--imw-surface)', color: 'var(--imw-muted)' },
  mutedBadge: { borderRadius: 6, padding: '3px 8px', fontSize: 11, color: 'var(--imw-muted)' },
  field: { display: 'flex', flexDirection: 'column', gap: 8, padding: '4px 0', minWidth: 0 },
  fieldHead: { display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 8, minHeight: 20 },
  label: { flex: 1, fontSize: 12, fontWeight: 550, color: 'var(--imw-muted)' },
  input,
  select: { ...input, paddingInlineEnd: 36,
    backgroundImage: 'var(--imw-chevron)', backgroundRepeat: 'no-repeat', backgroundSize: '16px 16px', backgroundPosition: 'right 12px center' },
  hint: { margin: 0, fontSize: 12, lineHeight: 1.7, color: 'var(--imw-muted)', overflowWrap: 'anywhere' },
  error: { margin: 0, fontSize: 12, lineHeight: 1.7, color: '#ca674c', overflowWrap: 'anywhere' },
  reset: { border: 0, background: 'none', color: 'var(--imw-accent)', cursor: 'pointer', padding: '2px 4px' },
  toggle: { display: 'inline-flex', alignItems: 'center', gap: 8, fontSize: 13 },
  qr: { alignSelf: 'center', maxWidth: '100%', height: 'auto', borderRadius: 12, background: '#fff' },
  loginActions: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' },
  footer: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', paddingTop: 12 },
  button: { minHeight: 40, border: '1px solid var(--imw-line)', borderRadius: 8, padding: '9px 14px', fontSize: 13, lineHeight: '20px', background: 'var(--imw-surface)', color: 'inherit', cursor: 'pointer' },
  save: { minHeight: 40, border: '1px solid var(--imw-accent)', borderRadius: 8, padding: '9px 14px', fontSize: 13, lineHeight: '20px', background: 'var(--imw-accent)', color: '#fff', cursor: 'pointer' },
  disabled: { opacity: .45, cursor: 'default' },
}
