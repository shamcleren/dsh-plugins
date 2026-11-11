import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { WeChatAccount } from '../../src/adapters/wechat/account.js'
import { WeChatAccountStore } from '../../src/adapters/wechat/storage.js'

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('WeChatAccount polling', () => {
  it('admits text commands with an empty client id and a 64-bit server id through the real protocol decoder', async () => {
    let acknowledged!: () => void
    const cursorRead = new Promise<void>(resolve => { acknowledged = resolve })
    vi.stubGlobal('fetch', vi.fn<typeof fetch>(async (input, init) => {
      if (!String(input).endsWith('/ilink/bot/getupdates')) return new Response('{"ret":0}')
      const request = JSON.parse(String(init?.body)) as { get_updates_buf: string }
      if (request.get_updates_buf === 'fixture-after-help') {
        acknowledged()
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true })
        })
      }
      return new Response('{"ret":0,"get_updates_buf":"fixture-after-help","msgs":[{"client_id":"","message_id":9223372036854775807,"from_user_id":"fixture-peer","item_list":[{"type":1,"text_item":{"text":"/help"}}]}]}')
    }))
    const directory = await mkdtemp(join(tmpdir(), 'dsh-im-command-')), store = await WeChatAccountStore.open(directory)
    const onMessage = vi.fn(async () => {})
    const account = new WeChatAccount({ accountId: 'fixture-account', token: 'fixture-token', baseUrl: 'https://ilink.example.test' }, store,
      { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), success: vi.fn() } as never, 1024, onMessage)
    try {
      account.start(); await cursorRead
      expect(onMessage).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ messageId: '9223372036854775807', content: [{ type: 'text', text: '/help' }] }))
      expect(store.cursor('fixture-account')).toBe('fixture-after-help')
    } finally { await account.stop(); await store.drain(); await rm(directory, { recursive: true, force: true }) }
  })
  it('retries a poison callback three times before advancing the batch cursor', async () => {
    vi.useFakeTimers()
    let polls = 0
    const fetchMock = vi.fn<typeof fetch>().mockImplementation(async (input, init) => {
      const url = String(input)
      if (!url.endsWith('/ilink/bot/getupdates')) return new Response('{"ret":0}', { status: 200 })
      polls += 1
      const request = JSON.parse(String(init?.body)) as { get_updates_buf: string }
      if (request.get_updates_buf === 'cursor-after-poison') {
        return await new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => {
            reject(new DOMException('aborted', 'AbortError'))
          }, { once: true })
        })
      }
      return new Response(JSON.stringify({
        ret: 0,
        get_updates_buf: 'cursor-after-poison',
        msgs: [{ client_id: 'poison-a', from_user_id: 'peer-a', item_list: [{ type: 1, text_item: { text: 'hello' } }] }],
      }), { status: 200 })
    })
    vi.stubGlobal('fetch', fetchMock)
    const directory = await mkdtemp(join(tmpdir(), 'dsh-wechat-poll-'))
    const store = await WeChatAccountStore.open(directory)
    const onMessage = vi.fn(async () => { throw new Error('invalid callback') })
    const account = new WeChatAccount(
      { accountId: 'account-a', token: 'token-a', baseUrl: 'https://ilink.example.test' },
      store,
      { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), success: vi.fn() } as never,
      1024,
      onMessage,
    )

    account.start()
    await vi.advanceTimersByTimeAsync(4_000)
    await vi.waitFor(() => { expect(store.cursor('account-a')).toBe('cursor-after-poison') })
    await account.stop()

    expect(onMessage).toHaveBeenCalledTimes(3)
  })
})
