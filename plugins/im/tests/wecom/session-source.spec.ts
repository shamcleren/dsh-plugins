import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { WeComGroupDirectory } from '../../src/adapters/wecom/group-directory.js'
import { conversationKeyFor, type WeComInboundText } from '../../src/adapters/wecom/inbound.js'
import { WeComSessionSources } from '../../src/adapters/wecom/session-source.js'

it('resolves each asker within the bot and keeps saved group names across restarts', async () => {
  const root = await mkdtemp(join(tmpdir(), 'wecom-sources-'))
  try {
    const alice: WeComInboundText = { botId: 'bot', conversationId: 'room', chatType: 'group', userId: 'member-a', messageId: 'msg', text: '问题' }
    const bob = { ...alice, userId: 'member-b' }
    const store = new WeComSessionSources(root)
    const directory = new WeComGroupDirectory(async () => ({ sessions: [
      { chat_type: 'group', chat_id: 'room', chat_name: '项目群' },
      { chat_type: 'single', chat_id: 'member-b', chat_name: '小乙' },
    ] }))
    await store.nameSelf(alice, '小甲')
    expect(await store.questionNames(alice, directory)).toEqual({ speaker: '小甲', group: '项目群' })
    expect(await store.questionNames(bob, directory)).toEqual({ speaker: '小乙', group: '项目群' })
    const reopened = new WeComSessionSources(root)
    expect(await reopened.questionNames(alice)).toEqual({ speaker: '小甲', group: '项目群' })
    expect((await reopened.questionNames({ ...alice, botId: 'other' })).speaker).toBeUndefined()
    await reopened.nameGroup(conversationKeyFor(alice), '值班群')
    expect((await reopened.questionNames(bob, directory)).group).toBe('值班群')
    expect(await reopened.questionNames({ ...alice, chatType: 'single', conversationId: alice.userId })).toEqual({ speaker: '小甲' })
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
