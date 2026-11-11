import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import Tools from '@deepseek-ai/dsh-tools'
import type { ToolCallId } from '@deepseek-ai/dsh-llm'
import { expect, it, vi } from 'vitest'
import { WeChatDelivery } from '../../src/adapters/wechat/delivery.js'
import { installPushTools, WeChatPushService } from '../../src/adapters/wechat/push.js'
import { WeChatAccountStore } from '../../src/adapters/wechat/storage.js'

it('exposes notifications through the official tools pipeline and a disposable scheduler service', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'wechat-tools-'))
  const store = await WeChatAccountStore.open(directory)
  const account = { accountId: 'account', userId: 'owner', token: 'fixture-token', baseUrl: 'https://example.invalid' }
  await store.saveAccount(account)
  await store.saveContextToken('account', 'owner', 'fixture-context')
  const delivery = await WeChatDelivery.open(directory, store,
    { current: (_key, fallback) => fallback }, () => ['account'], vi.fn())
  const ctx = new Context()
  try {
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(Tools)
    const fiber = await ctx.plugin({ apply(scope: Context) {
      new WeChatPushService(scope, delivery)
      installPushTools(scope, delivery)
    } })
    await vi.waitFor(() => expect(ctx.tools.get('wechat_notify')).toBeDefined())
    const call = (name: string, args: unknown, callId = name) => ctx.tools.execute({
      name, arguments: args, callId: callId as ToolCallId, signal: new AbortController().signal,
    })
    const unavailable = await call('wechat_notify', { text: 'before interaction' })
    expect(unavailable.isError).toBe(true)
    await delivery.observe(account, 'owner', 'message')
    expect((await call('wechat_recipients', {})).value).toEqual([expect.objectContaining({ accountId: 'account', owner: true })])
    const recipientId = delivery.recipients()[0]!.recipientId
    const list = ctx.tools.get('wechat_recipients')!
    await expect(list.execute({}, { agent: { session: { id: 'child', header: { parentSession: `session-wechat-${recipientId}` } } } } as never))
      .resolves.toEqual([expect.objectContaining({ recipientId })])
    await expect(list.execute({}, { agent: { session: { id: 'child', header: { parentSession: 'unloaded-parent' } } } } as never))
      .rejects.toMatchObject({ code: 'session-lineage-unavailable' })
    const gate = ctx.on('tools/pre-execute', async (exec, next) => exec.name === 'wechat_notify'
      ? { kind: 'deny' as const, reason: 'fixture denies external sends' } : next())
    expect((await call('wechat_notify', { text: 'denied' })).isError).toBe(true)
    gate()
    const result = await call('wechat_notify', { text: 'scheduled result', idempotencyKey: 'occurrence' })
    expect(result.isError).toBe(false)
    expect(result.value).toMatchObject({ status: 'queued' })
    const receipt = await ctx.wechatPush.notify({ text: 'service result', idempotencyKey: 'scheduler-job@time' })
    expect(ctx.wechatPush.status(receipt.id).status).toBe('queued')
    expect((await ctx.wechatPush.cancel(receipt.id)).status).toBe('cancelled')
    await fiber.dispose()
    await vi.waitFor(() => expect(ctx.tools.get('wechat_notify')).toBeUndefined())
    expect(ctx.get('wechatPush')).toBeUndefined()
  } finally {
    await ctx.fiber.dispose()
    await delivery.stop()
    await rm(directory, { recursive: true, force: true })
  }
})
