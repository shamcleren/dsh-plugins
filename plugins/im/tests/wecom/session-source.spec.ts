import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { WeComSessionSources } from '../../src/adapters/wecom/session-source.js'

it('persists group aliases per conversation and deduplicates speakers per session', async () => {
  const root = await mkdtemp(join(tmpdir(), 'wecom-sources-'))
  try {
    const store = new WeComSessionSources(root)
    const group = 'a'.repeat(64), first = 'session-wecom-first', second = 'session-wecom-second'
    expect(await store.get(first)).toBeNull()
    await store.record(first, group, 'alice')
    await store.record(first, group, 'bob')
    await store.record(first, group, 'alice')
    await store.record(second, group, 'bob')
    expect((await store.get(first))?.group).toMatch(/^#a+/)
    await store.nameGroup(group, '测试群')
    const reopened = new WeComSessionSources(root)
    expect(await reopened.get(first)).toEqual({ group: '测试群', speakers: ['alice', 'bob'] })
    expect(await reopened.get(second)).toEqual({ group: '测试群', speakers: ['bob'] })
    await expect(store.record(first, 'b'.repeat(64), 'guest')).rejects.toThrow('conflict')
    await expect(store.get('../escape')).rejects.toThrow()
  } finally { await rm(root, { recursive: true, force: true }) }
})
