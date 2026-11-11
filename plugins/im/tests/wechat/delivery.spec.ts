import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { WeChatDelivery, recipientIdFor } from '../../src/adapters/wechat/delivery.js'
import { WeChatAccountStore } from '../../src/adapters/wechat/storage.js'
import type { WeChatAccountCredentials } from '../../src/adapters/wechat/protocol.js'

const cleanup: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const dispose of cleanup.splice(0).reverse()) await dispose()
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

async function fixture(count = 1) {
  const directory = await mkdtemp(join(tmpdir(), 'wechat-delivery-'))
  cleanup.push(() => rm(directory, { recursive: true, force: true }))
  const store = await WeChatAccountStore.open(directory)
  const accounts: WeChatAccountCredentials[] = Array.from({ length: count }, (_, index) => ({
    accountId: `account-${index}`, userId: `owner-${index}`, token: `private-bot-${index}`, baseUrl: 'https://ilink.example.test',
  }))
  for (const account of accounts) await store.saveAccount(account)
  const bindings = new Map<string, string>()
  const open = async () => {
    const delivery = await WeChatDelivery.open(directory, store,
      { current: (key, fallback) => bindings.get(key) ?? fallback },
      () => accounts.map(account => account.accountId), vi.fn())
    cleanup.push(() => delivery.stop())
    return delivery
  }
  const delivery = await open()
  const receive = async (index = 0, userId = accounts[index]!.userId!, messageId = 'message-1', target = delivery) => {
    const account = accounts[index]!
    await store.saveContextToken(account.accountId, userId, `private-context-${index}`)
    await target.observe(account, userId, messageId)
    return recipientIdFor(account.accountId, userId)
  }
  const fetchMock = vi.fn<typeof fetch>().mockImplementation(async () => new Response('{"ret":0}'))
  vi.stubGlobal('fetch', fetchMock)
  return { directory, store, accounts, delivery, open, receive, fetchMock, bindings }
}

describe('durable WeChat notifications', () => {
  it('fails closed for ambiguous accounts, unknown peers, and cross-peer channel calls', async () => {
    const f = await fixture(2)
    const owner0 = await f.receive()
    await expect(f.delivery.notify({ text: 'task result' })).rejects.toMatchObject({ code: 'recipient-ambiguous' })
    await f.receive(1)
    await expect(f.delivery.notify({ text: 'task result', recipientId: 'unknown' })).rejects.toMatchObject({ code: 'recipient-unavailable' })
    const peer = await f.receive(0, 'other-user')
    const channelSession = `session-wechat-${peer}`
    expect(f.delivery.recipients(channelSession).map(item => item.recipientId)).toEqual([peer])
    await expect(f.delivery.notify({ text: 'leak', recipientId: owner0 }, channelSession)).rejects.toMatchObject({ code: 'recipient-not-owned' })
    await expect(f.delivery.notify({ text: 'leak' }, 'session-wechat-retired')).rejects.toMatchObject({ code: 'unbound-channel-session' })
    const result = await f.delivery.notify({ text: 'owner result', accountId: 'account-1' }, 'desktop-session')
    expect(result.recipientId).toBe(recipientIdFor('account-1', 'owner-1'))
    expect(f.fetchMock).not.toHaveBeenCalled()
  })

  it('persists admitted work and credentials stay out of receipts and the outbox', async () => {
    const f = await fixture()
    await f.receive()
    const result = await f.delivery.notify({ text: 'scheduled result', idempotencyKey: 'job-1@occurrence-1' }, 'desktop')
    await f.delivery.stop()
    const restored = await f.open()
    expect(restored.status(result.id, 'desktop').status).toBe('queued')
    expect(() => restored.status(result.id, 'other-session')).toThrow('notification-not-found')
    const document = await readFile(join(f.directory, 'outbox.json'), 'utf8')
    expect(document).not.toContain('private-bot')
    expect(document).not.toContain('private-context')
    expect((await stat(join(f.directory, 'outbox.json'))).mode & 0o777).toBe(0o600)
    restored.resume()
    await vi.waitFor(() => expect(restored.status(result.id).status).toBe('sent'))
    const body = JSON.parse(String(f.fetchMock.mock.calls[0]![1]?.body))
    expect(body.msg).toMatchObject({ to_user_id: 'owner-0', context_token: 'private-context-0',
      item_list: [{ type: 1, text_item: { text: 'scheduled result' } }] })
    expect(JSON.stringify(restored.recipients())).not.toContain('private-')
  })

  it('deduplicates concurrent callers and preserves idempotency after the interaction expires', async () => {
    const f = await fixture()
    await f.receive()
    const request = { text: 'once', idempotencyKey: 'occurrence' }
    const [a, b] = await Promise.all([f.delivery.notify(request), f.delivery.notify(request)])
    expect(a.id).toBe(b.id)
    await expect(f.delivery.notify({ ...request, text: 'changed' })).rejects.toMatchObject({ code: 'idempotency-conflict' })
    vi.useFakeTimers()
    vi.setSystemTime(Date.now() + 25 * 60 * 60_000)
    expect((await f.delivery.notify(request)).id).toBe(a.id)
    await expect(f.delivery.notify({ text: 'new result' })).rejects.toMatchObject({ code: 'recipient-needs-message' })
  })

  it('shares the window budget with replies, reserves two reply slots, and ignores callback replays', async () => {
    const f = await fixture()
    await f.receive()
    for (let i = 0; i < 8; i++) await f.delivery.send(f.accounts[0]!, 'owner-0',
      { type: 1, text_item: { text: `reply-${i}` } }, 'private-context-0', new AbortController().signal)
    const result = await f.delivery.notify({ text: 'notification' })
    f.delivery.resume()
    await vi.waitFor(() => expect(f.delivery.status(result.id).code).toBe('waiting-for-message'))
    expect(f.fetchMock).toHaveBeenCalledTimes(8)
    await f.receive()
    expect(f.delivery.status(result.id).code).toBe('waiting-for-message')
    await f.receive(0, 'owner-0', 'message-2')
    await vi.waitFor(() => expect(f.delivery.status(result.id).status).toBe('sent'))
    expect(f.fetchMock).toHaveBeenCalledTimes(9)
  })

  it('bounds push frequency and resumes Unicode chunks without replaying accepted chunks', async () => {
    vi.useFakeTimers()
    const f = await fixture()
    await f.receive()
    const result = await f.delivery.notify({ text: '😀'.repeat(2_500) })
    f.delivery.resume()
    await vi.waitFor(() => expect(f.delivery.status(result.id).sentChunks).toBe(1))
    await f.delivery.pause()
    const restored = await f.open()
    restored.resume()
    await vi.advanceTimersByTimeAsync(9_000)
    expect(f.fetchMock).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1_000)
    await vi.waitFor(() => expect(restored.status(result.id).status).toBe('sent'))
    const texts = f.fetchMock.mock.calls.map(([, init]) => JSON.parse(String(init?.body)).msg.item_list[0].text_item.text)
    expect(texts.join('')).toBe('😀'.repeat(2_500))
    expect(texts.every((text: string) => !/[\uD800-\uDBFF]$/u.test(text))).toBe(true)
    const ids = f.fetchMock.mock.calls.map(([, init]) => JSON.parse(String(init?.body)).msg.client_id)
    expect(new Set(ids).size).toBe(2)
  })

  it('retains a confirmed throttle for retry and unblocks the other recipient', async () => {
    vi.useFakeTimers()
    const f = await fixture(2)
    await f.receive(); await f.receive(1)
    f.fetchMock.mockImplementationOnce(async () => new Response('', { status: 429, headers: { 'Retry-After': '60' } }))
    const first = await f.delivery.notify({ text: 'a', accountId: 'account-0' })
    const second = await f.delivery.notify({ text: 'b', accountId: 'account-1' })
    f.delivery.resume()
    await vi.waitFor(() => expect(f.delivery.status(first.id).code).toBe('throttled'))
    const retryAt = f.delivery.status(first.id).nextAttemptAt
    await f.receive(0, 'owner-0', 'message-during-backoff')
    expect(f.delivery.status(first.id).nextAttemptAt).toBe(retryAt)
    await vi.advanceTimersByTimeAsync(10_000)
    await vi.waitFor(() => expect(f.delivery.status(second.id).status).toBe('sent'))
    await vi.advanceTimersByTimeAsync(50_000)
    await vi.waitFor(() => expect(f.delivery.status(first.id).status).toBe('sent'))
    expect(f.fetchMock).toHaveBeenCalledTimes(3)
  })

  it.each(['network', 'malformed', 'server', 'rejected'])('does not blindly retry %s failures', async mode => {
    const f = await fixture()
    await f.receive()
    f.fetchMock.mockImplementation(async () => {
      if (mode === 'network') throw new Error('response lost private-bot-0')
      if (mode === 'malformed') return new Response('{}')
      if (mode === 'server') return new Response('private-bot-0', { status: 503 })
      return new Response('{"ret":-5,"errmsg":"private-bot-0"}')
    })
    const result = await f.delivery.notify({ text: 'result', idempotencyKey: 'retry' })
    f.delivery.resume()
    await vi.waitFor(() => expect(f.delivery.status(result.id).status).toBe(mode === 'rejected' ? 'failed' : 'uncertain'))
    await f.delivery.pause()
    const restored = await f.open()
    restored.resume()
    expect((await restored.notify({ text: 'result', idempotencyKey: 'retry' })).id).toBe(result.id)
    expect(f.fetchMock).toHaveBeenCalledTimes(1)
    expect(JSON.stringify(restored.status(result.id))).not.toContain('private-')
  })

  it('waits for a new inbound context instead of deleting tokens after a remote context refusal', async () => {
    const f = await fixture()
    await f.receive()
    f.fetchMock.mockImplementationOnce(async () => new Response('{"ret":-2,"errmsg":"prepare failed"}'))
    const result = await f.delivery.notify({ text: 'result' })
    f.delivery.resume()
    await vi.waitFor(() => expect(f.delivery.status(result.id).code).toBe('context'))
    expect(f.store.contextToken('account-0', 'owner-0')).toBe('private-context-0')
    await f.delivery.pause()
    vi.useFakeTimers()
    vi.setSystemTime(Date.now() + 10_000)
    await f.receive(0, 'owner-0', 'new-message')
    f.delivery.resume()
    await vi.waitFor(() => expect(f.delivery.status(result.id).status).toBe('sent'))
  })

  it('recovers an interrupted send as uncertain and rejects corrupt state without overwriting it', async () => {
    const f = await fixture()
    await f.receive()
    const result = await f.delivery.notify({ text: 'result' })
    await f.delivery.stop()
    const path = join(f.directory, 'outbox.json'), document = JSON.parse(await readFile(path, 'utf8'))
    document.jobs[0].status = 'sending'
    await writeFile(path, JSON.stringify(document))
    const restored = await f.open()
    expect(restored.status(result.id)).toMatchObject({ status: 'uncertain', code: 'interrupted-send' })
    await restored.stop()
    await writeFile(path, '{corrupt')
    await expect(f.open()).rejects.toMatchObject({ code: 'outbox-unreadable' })
    expect(await readFile(path, 'utf8')).toBe('{corrupt')
  })

  it('does not let a late refusal close the interaction opened during its request', async () => {
    const f = await fixture()
    await f.receive()
    let refuse!: (value: Response) => void
    f.fetchMock.mockImplementationOnce(async () => new Promise(resolve => { refuse = resolve }))
    const result = await f.delivery.notify({ text: 'result' })
    f.delivery.resume()
    await vi.waitFor(() => expect(f.fetchMock).toHaveBeenCalledOnce())
    await f.receive(0, 'owner-0', 'fresh-message')
    refuse(new Response('{"ret":-2,"errmsg":"prepare failed"}'))
    await vi.waitFor(() => expect(f.delivery.status(result.id).code).toBe('context'))
    await f.delivery.pause()
    expect(f.delivery.recipients()[0]!.available).toBe(true)
    vi.useFakeTimers(); vi.setSystemTime(Date.now() + 10_000)
    f.delivery.resume()
    await vi.waitFor(() => expect(f.delivery.status(result.id).status).toBe('sent'))
    expect(f.fetchMock).toHaveBeenCalledTimes(2)
  })

  it('does not let an old reply context close a window renewed before dispatch', async () => {
    const f = await fixture()
    await f.receive()
    await f.receive(0, 'owner-0', 'new-message')
    await f.store.saveContextToken('account-0', 'owner-0', 'new-context')
    f.fetchMock.mockImplementationOnce(async () => new Response('{"ret":-2,"errmsg":"context expired"}'))
    await expect(f.delivery.send(f.accounts[0]!, 'owner-0', { type: 1, text_item: { text: 'late reply' } },
      'old-context', new AbortController().signal)).rejects.toMatchObject({ kind: 'context' })
    expect(f.delivery.recipients()[0]!.available).toBe(true)
    const result = await f.delivery.notify({ text: 'new notification' })
    f.delivery.resume()
    await vi.waitFor(() => expect(f.delivery.status(result.id).status).toBe('sent'))
    const body = JSON.parse(String(f.fetchMock.mock.calls[1]![1]?.body))
    expect(body.msg.context_token).toBe('new-context')
  })

  it('cancels queued work, rejects credential changes, and expires undeliverable jobs', async () => {
    const f = await fixture()
    await f.receive()
    const cancelled = await f.delivery.notify({ text: 'cancel' }, 'desktop')
    expect((await f.delivery.cancel(cancelled.id, 'desktop')).status).toBe('cancelled')
    const changed = await f.delivery.notify({ text: 'old account' })
    await f.store.saveAccount({ ...f.accounts[0]!, token: 'replacement' })
    f.delivery.resume()
    await vi.waitFor(() => expect(f.delivery.status(changed.id).code).toBe('account-changed'))
    await f.delivery.pause()
    await f.store.saveAccount(f.accounts[0]!)
    const expiring = await f.delivery.notify({ text: 'expiry' })
    vi.useFakeTimers(); vi.setSystemTime(Date.now() + 25 * 60 * 60_000)
    f.delivery.resume()
    await vi.waitFor(() => expect(f.delivery.status(expiring.id)).toMatchObject({ status: 'failed', code: 'expired' }))
    await expect(f.delivery.notify({ text: 'after stop' })).rejects.toMatchObject({ code: 'recipient-needs-message' })
    expect(f.fetchMock).not.toHaveBeenCalled()
  })

  it('aborts and joins an in-flight send on stop, leaving its uncertain outcome inspectable', async () => {
    const f = await fixture()
    await f.receive()
    f.fetchMock.mockImplementation(async (_url, init) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true })
    }))
    const result = await f.delivery.notify({ text: 'in flight' })
    f.delivery.resume()
    await vi.waitFor(() => expect(f.fetchMock).toHaveBeenCalledOnce())
    await f.delivery.stop()
    expect(f.delivery.status(result.id).status).toBe('uncertain')
    await expect(f.delivery.notify({ text: 'new' })).rejects.toMatchObject({ code: 'stopped' })
  })

  it('keeps arbitrary caller cancellation reasons from disabling future delivery', async () => {
    const f = await fixture()
    await f.receive()
    const abort = new AbortController(), reason = new Error('caller cancelled')
    abort.abort(reason)
    await expect(f.delivery.notify({ text: 'cancelled admission' }, undefined, abort.signal)).rejects.toBe(reason)
    await expect(f.delivery.notify({ text: 'next notification' })).resolves.toMatchObject({ status: 'queued' })
    await expect(f.delivery.send(f.accounts[0]!, 'owner-0', { type: 1, text_item: { text: 'normal reply' } },
      'private-context-0', new AbortController().signal)).resolves.toBeUndefined()
    expect(f.fetchMock).toHaveBeenCalledOnce()
  })

  it('restores a notification stopped while waiting behind an ordinary reply', async () => {
    const f = await fixture()
    await f.receive()
    let finish!: (response: Response) => void
    f.fetchMock.mockImplementationOnce(async () => new Promise(resolve => { finish = resolve }))
    const reply = f.delivery.send(f.accounts[0]!, 'owner-0', { type: 1, text_item: { text: 'reply' } },
      'private-context-0', new AbortController().signal)
    await vi.waitFor(() => expect(f.fetchMock).toHaveBeenCalledOnce())
    const result = await f.delivery.notify({ text: 'after reply' })
    const sending = vi.spyOn(f.delivery, 'send')
    f.delivery.resume()
    await vi.waitFor(() => expect(sending).toHaveBeenCalledOnce())
    const stopped = f.delivery.stop()
    finish(new Response('{"ret":0}'))
    await Promise.all([reply, stopped])
    expect(f.delivery.status(result.id).status).toBe('queued')
    const restored = await f.open()
    restored.resume()
    await vi.waitFor(() => expect(restored.status(result.id).status).toBe('sent'))
    expect(f.fetchMock).toHaveBeenCalledTimes(2)
  })
})
