import { mkdtemp, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { describe, expect, it } from 'vitest'
import { ConversationBindings } from '../src/bindings.js'

describe('ConversationBindings', () => {
  it('persists only hashed conversation keys and opaque session ids', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'wecom-bindings-'))
    const filename = join(directory, 'bindings.json')
    const key = 'a'.repeat(64)
    const store = await ConversationBindings.open(filename)
    expect(store.current(key, 'session-wecom-fallback')).toBe('session-wecom-fallback')

    await store.set(key, 'session-wecom-new')
    await store.drain()
    const text = await readFile(filename, 'utf8')
    expect(text).toContain(key)
    expect(text).toContain('session-wecom-new')

    const reopened = await ConversationBindings.open(filename)
    expect(reopened.current(key, 'session-wecom-fallback')).toBe('session-wecom-new')
  })
})
