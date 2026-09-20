import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { load } from 'js-yaml'
import { describe, expect, it } from 'vitest'
import { POLICY } from '../src/index.ts'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

describe('Codex controller bundle', () => {
  it('registers one controller and keeps the public tool name out of the one-shot composition', async () => {
    const document = load(await readFile(join(root, 'cordis.patch.yml'), 'utf8')) as Array<{ insert?: Array<{ id: string; name: string; config?: Record<string, unknown> }> }>
    const rows = document.flatMap(entry => entry.insert ?? [])
    expect(rows.map(row => row.id)).toEqual(['codex-controller'])
    expect(rows[0]?.name).toBe('@shamcleren/dsh-codex-controller')
    expect(JSON.stringify(document)).not.toContain('permissionMode')
    expect(JSON.stringify(document)).not.toContain('one-shot')
  })

  it('requires an explicit visible Codex session', () => {
    expect(POLICY).toContain('visible Codex session')
    expect(POLICY).toContain('do not replay them as DSH tool calls')
    expect(POLICY).not.toContain('permissionMode: never')
  })
})
