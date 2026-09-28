/** Inline styles keep the external client bundle independent of repository CSS tooling. */

import type { CSSProperties } from 'react'

/** Mirrors the official plugin-manager config pages: flat sections, no wrapping card. */
export const styles = {
  form: { display: 'flex', flexDirection: 'column', minWidth: 0 },
  section: { minWidth: 0, padding: '16px 0' },
  sectionHeading: {
    margin: 0, fontSize: 13, fontWeight: 600, lineHeight: 1.5, color: 'var(--dsw-alias-label-primary)',
  },
  field: { display: 'flex', flexDirection: 'column', gap: 6, padding: '12px 0' },
  fieldHead: { display: 'flex', alignItems: 'center', gap: 8 },
  label: { flex: 1, fontSize: 13, fontWeight: 500, color: 'var(--dsw-alias-label-primary)' },
  input: {
    height: 34, padding: '0 12px', border: '0.5px solid var(--dsw-alias-border-l2)', borderRadius: 8,
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
