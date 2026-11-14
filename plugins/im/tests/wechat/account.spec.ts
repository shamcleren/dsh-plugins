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

it.each(['upload', 'send'] as const)('reports sanitized %s stage without retrying media delivery', async stage => {
  const fetch = vi.fn<typeof globalThis.fetch>(async input => {
    const url = String(input)
    if (stage === 'upload') throw new Error('https://cdn.test/?secret=TOKEN /private/file.jpg')
    if (url.endsWith('/getuploadurl')) return Response.json({ ret: 0, upload_full_url: 'https://cdn.test/upload' })
    if (url === 'https://cdn.test/upload') return new Response('', { status: 200, headers: { 'x-encrypted-param': 'fixture-param' } })
    return Response.json({ ret: -1, errmsg: 'secret failure body' })
  })
  vi.stubGlobal('fetch', fetch)
  const directory = await mkdtemp(join(tmpdir(), 'dsh-im-media-stage-'))
  const store = await WeChatAccountStore.open(directory)
  const account = new WeChatAccount({ accountId: 'fixture-account', token: 'fixture-token', baseUrl: 'https://ilink.example.test' }, store,
    { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), success: vi.fn() } as never, 1024, async () => undefined)
  try {
    await expect(account.sendImage('fixture-peer', Buffer.from('ffd8ffe0', 'hex'), 'fixture-context'))
      .rejects.toMatchObject({ stage, category: stage === 'upload' ? 'unknown' : 'rejected' })
    expect(fetch).toHaveBeenCalledTimes(stage === 'upload' ? 1 : 3)
  } finally { await account.stop(); await store.drain(); await rm(directory, { recursive: true, force: true }) }
})

it.each(['image', 'video', 'file'] as const)('matches Tencent outbound %s key and size contracts', async kind => {
  const { createDecipheriv } = await import('node:crypto')
  const source = Buffer.from('fixed-contract-fixture-17')
  const fetch = vi.fn<typeof globalThis.fetch>()
    .mockResolvedValueOnce(Response.json({ upload_full_url: 'https://cdn.test/upload' }))
    .mockResolvedValueOnce(new Response('', { headers: { 'x-encrypted-param': 'fixture-param' } }))
    .mockResolvedValueOnce(Response.json({ ret: 0 }))
  vi.stubGlobal('fetch', fetch)
  const directory = await mkdtemp(join(tmpdir(), 'dsh-im-media-contract-'))
  const store = await WeChatAccountStore.open(directory)
  const account = new WeChatAccount({ accountId: 'fixture', token: 'fixture', baseUrl: 'https://ilink.example.test' },
    store, { warn: vi.fn(), error: vi.fn() } as never, 1024, async () => undefined)
  try {
    if (kind === 'image') await account.sendImage('fixture', source, 'fixture')
    else if (kind === 'video') await account.sendVideo('fixture', source, 'fixture')
    else await account.sendFile('fixture', source, 'fixture.txt', 'fixture')
    const reservation = JSON.parse(String(fetch.mock.calls[0]![1]!.body))
    const ciphertext = Buffer.from(fetch.mock.calls[1]![1]!.body as Uint8Array)
    const item = JSON.parse(String(fetch.mock.calls[2]![1]!.body)).msg.item_list[0][`${kind}_item`]
    const hex = Buffer.from(item.media.aes_key, 'base64').toString('utf8')
    expect(hex).toMatch(/^[0-9a-f]{32}$/u)
    expect(hex).toBe(reservation.aeskey)
    const decipher = createDecipheriv('aes-128-ecb', Buffer.from(hex, 'hex'), null)
    expect(Buffer.concat([decipher.update(ciphertext), decipher.final()])).toEqual(source)
    expect(kind === 'file' ? Number(item.len) : kind === 'video' ? item.video_size : item.mid_size)
      .toBe(kind === 'file' ? source.length : ciphertext.length)
    expect(fetch).toHaveBeenCalledTimes(3)
  } finally { await account.stop(); await store.drain(); await rm(directory, { recursive: true, force: true }) }
})
