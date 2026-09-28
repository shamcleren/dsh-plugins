/** Inline styles keep the external client bundle independent of repository CSS tooling. */

import type { CSSProperties } from 'react'

/** Mirrors the official plugin-manager config pages: flat sections, no wrapping card. */
export const styles = {
  form: { display: 'flex', flexDirection: 'column', gap: 4, minWidth: 0 },
  section: { display: 'flex', flexDirection: 'column', gap: 8, minWidth: 0, padding: '16px 0' },
  sectionHeading: {
    flex: 1, margin: 0, fontSize: 13, fontWeight: 600, lineHeight: 1.5, color: 'var(--dsw-alias-label-primary)',
  },
  hiddenLabel: { position: 'absolute', width: 1, height: 1, overflow: 'hidden', clip: 'rect(0 0 0 0)' },
  badge: {
    borderRadius: 999, padding: '1px 8px', fontSize: 11, lineHeight: '17px',
    background: 'var(--dsw-alias-bg-module-platform)', color: 'var(--dsw-alias-label-secondary)',
  },
  mutedBadge: { borderRadius: 999, padding: '1px 8px', fontSize: 11, color: 'var(--dsw-alias-label-tertiary)' },
  field: { display: 'flex', flexDirection: 'column', gap: 6, padding: '12px 0' },
  fieldHead: { display: 'flex', alignItems: 'center', gap: 8 },
  label: { flex: 1, fontSize: 13, fontWeight: 500, color: 'var(--dsw-alias-label-primary)' },
  input: {
    height: 34, padding: '0 12px', border: '0.5px solid var(--dsw-alias-border-l2)', borderRadius: 8,
    background: 'var(--dsw-alias-bg-layer-3)', color: 'var(--dsw-alias-label-primary)', fontSize: 13,
  },
  hint: { margin: 0, fontSize: 12, lineHeight: 1.5, color: 'var(--dsw-alias-label-tertiary)' },
  error: { margin: 0, fontSize: 12, lineHeight: 1.5, color: 'var(--dsw-alias-label-error)' },
  reset: { border: 0, background: 'none', color: 'var(--dsw-alias-label-secondary)', cursor: 'pointer' },
  toggle: { display: 'inline-flex', alignItems: 'center', gap: 8, fontSize: 13 },
  qr: { alignSelf: 'center', borderRadius: 8, background: '#fff' },
  loginActions: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' },
  footer: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', paddingTop: 8 },
  button: {
    border: '1px solid var(--dsw-alias-border-l2)', borderRadius: 8, padding: '5px 14px',
    background: 'transparent', color: 'var(--dsw-alias-label-secondary)', cursor: 'pointer',
  },
  save: {
    border: '1px solid transparent', borderRadius: 8, padding: '5px 14px', fontSize: 13,
    background: 'var(--dsw-alias-label-primary)', color: 'var(--dsw-alias-bg-layer-3)', cursor: 'pointer',
  },
  disabled: { opacity: 0.4, cursor: 'default' },
} satisfies Record<string, CSSProperties>
