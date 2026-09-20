import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { WeChatAccount } from '../src/account.js'
import { WeChatAccountStore } from '../src/storage.js'

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('WeChatAccount polling', () => {
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
