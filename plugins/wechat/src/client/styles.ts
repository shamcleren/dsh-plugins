/** Inline styles keep the external client bundle independent of repository CSS tooling. */

import type { CSSProperties } from 'react'

export const styles = {
  card: {
    listStyle: 'none', border: '1px solid var(--dsw-alias-border-l2)', borderRadius: 12,
    background: 'var(--dsw-alias-bg-layer-3)', overflow: 'hidden',
  },
  summary: {
    cursor: 'pointer', padding: '14px 16px', color: 'var(--dsw-alias-label-primary)',
  },
  heading: { display: 'flex', alignItems: 'center', gap: 12 },
  headText: { flex: 1, display: 'flex', flexDirection: 'column', gap: 4 },
  title: { fontSize: 15, fontWeight: 600, lineHeight: 1.4 },
  description: { fontSize: 13, lineHeight: 1.5, color: 'var(--dsw-alias-label-tertiary)' },
  badge: {
    borderRadius: 999, padding: '1px 8px', fontSize: 11, lineHeight: '17px',
    background: 'var(--dsw-alias-bg-module-platform)', color: 'var(--dsw-alias-label-secondary)',
  },
  mutedBadge: { borderRadius: 999, padding: '1px 8px', fontSize: 11, color: 'var(--dsw-alias-label-tertiary)' },
  body: { borderTop: '1px solid var(--dsw-alias-border-l2)', margin: '0 16px', paddingBottom: 8 },
  field: { display: 'flex', flexDirection: 'column', gap: 6, padding: '12px 0' },
  fieldHead: { display: 'flex', alignItems: 'center', gap: 8 },
  label: { flex: 1, fontSize: 13, fontWeight: 500, color: 'var(--dsw-alias-label-primary)' },
  input: {
    height: 34, padding: '0 12px', border: '1px solid var(--dsw-alias-border-l2)', borderRadius: 8,
    background: 'var(--dsw-alias-bg-layer-3)', color: 'var(--dsw-alias-label-primary)', fontSize: 13,
  },
  hint: { margin: 0, fontSize: 12, lineHeight: 1.5, color: 'var(--dsw-alias-label-tertiary)' },
  error: { margin: 0, fontSize: 12, lineHeight: 1.5, color: 'var(--dsw-alias-label-error)' },
  reset: { border: 0, background: 'none', color: 'var(--dsw-alias-label-secondary)', cursor: 'pointer' },
  toggle: { display: 'inline-flex', alignItems: 'center', gap: 8, fontSize: 13 },
  qr: { alignSelf: 'center', borderRadius: 8, background: '#fff' },
  loginActions: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' },
  footer: {
    display: 'flex', justifyContent: 'flex-end', alignItems: 'center', gap: 8,
    padding: '12px 0 4px', borderTop: '1px solid var(--dsw-alias-border-l2)',
  },
  button: {
    border: '1px solid var(--dsw-alias-border-l2)', borderRadius: 8, padding: '5px 14px',
    background: 'transparent', color: 'var(--dsw-alias-label-secondary)', cursor: 'pointer',
  },
  save: {
    border: 0, borderRadius: 8, padding: '6px 14px', background: 'var(--dsw-alias-label-primary)',
    color: 'var(--dsw-alias-bg-layer-3)', cursor: 'pointer',
  },
} satisfies Record<string, CSSProperties>
