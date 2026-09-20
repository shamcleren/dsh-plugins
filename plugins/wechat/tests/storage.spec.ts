import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { WeChatAccountStore } from '../src/storage.js'

describe('WeChatAccountStore', () => {
  it('restores accounts, cursors, and peer context tokens after restart', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'dsh-wechat-store-'))
    const store = await WeChatAccountStore.open(directory)
    await store.saveAccount({ accountId: 'account-a', token: 'secret-token', baseUrl: 'https://example.test' })
    await store.saveCursor('account-a', 'cursor-2')
    await store.saveContextToken('account-a', 'peer-a', 'context-3')

    const restored = await WeChatAccountStore.open(directory)

    expect(restored.accounts([])).toEqual([
      { accountId: 'account-a', token: 'secret-token', baseUrl: 'https://example.test' },
    ])
    expect(restored.cursor('account-a')).toBe('cursor-2')
    expect(restored.contextToken('account-a', 'peer-a')).toBe('context-3')
    expect((await readFile(join(directory, 'accounts.json'), 'utf8')).endsWith('\n')).toBe(true)
  })

  it('selects only explicitly configured accounts', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'dsh-wechat-accounts-'))
    const store = await WeChatAccountStore.open(directory)
    await store.saveAccount({ accountId: 'a', token: 'one', baseUrl: 'https://a.test' })
    await store.saveAccount({ accountId: 'b', token: 'two', baseUrl: 'https://b.test' })

    expect(store.accounts(['b']).map(account => account.accountId)).toEqual(['b'])
  })
})
