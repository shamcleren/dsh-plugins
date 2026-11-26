import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { WeComGroupDirectory } from '../../src/adapters/wecom/group-directory.js'
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
    await store.rememberDirectoryName(group, '目录群名')
    expect((await store.get(first))?.group).toBe('目录群名')
    await store.nameGroup(group, '测试群')
    await store.rememberDirectoryName(group, '新目录群名')
    const reopened = new WeComSessionSources(root)
    expect(await reopened.get(first)).toEqual({ group: '测试群', speakers: ['alice', 'bob'] })
    expect(await reopened.get(second)).toEqual({ group: '测试群', speakers: ['bob'] })
    await expect(store.record(first, 'b'.repeat(64), 'guest')).rejects.toThrow('conflict')
    await expect(store.get('../escape')).rejects.toThrow()
  } finally { await rm(root, { recursive: true, force: true }) }
})

it('uses only an unambiguous exact group match and shares concurrent directory reads', async () => {
  let reads = 0
  const row = (chat_id: string, chat_name: string, chat_type = 'group') => ({ chat_id, chat_name, chat_type })
  const directory = new WeComGroupDirectory(async () => {
    reads++
    return { sessions: [row('one', '群一'), row('two', '群二'), row('two', '群三'), row('private', '昵称', 'single')] }
  })
  expect(await Promise.all(['one', 'two', 'private', 'on'].map(id => directory.name(id)))).toEqual(['群一', undefined, undefined, undefined])
  expect(reads).toBe(1)
  expect(await new WeComGroupDirectory(async () => { throw Error('CLI unavailable') }).name('one')).toBeUndefined()
})
