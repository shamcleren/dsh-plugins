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
  toggle: { display: 'inline-flex', alignItems: 'center', gap: 8, fontSize: 13 },
  grid: { display: 'flex', flexWrap: 'wrap', gap: 8, marginTop: 2 },
  thumb: {
    display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 4,
    width: 64, padding: 6, border: '2px solid var(--dsw-alias-border-l2)', borderRadius: 10,
    background: 'var(--dsw-alias-bg-layer-3)', cursor: 'pointer', boxSizing: 'border-box',
  },
  thumbSelected: { borderColor: 'var(--dsw-alias-accent)' },
  thumbName: {
    fontSize: 11, lineHeight: 1.3, color: 'var(--dsw-alias-label-secondary)',
    maxWidth: '100%', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
  },
} satisfies Record<string, CSSProperties>
