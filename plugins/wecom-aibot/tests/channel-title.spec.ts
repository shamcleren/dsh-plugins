import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it, vi } from 'vitest'
import { channelTitle, installChannelTitle } from '../src/channel-title.js'

describe('WeCom channel titles', () => {
  it('prefixes a generated title once', () => {
    expect(channelTitle('修复登录')).toBe('【企业微信】修复登录')
    expect(channelTitle('【企业微信】修复登录')).toBe('【企业微信】修复登录')
    expect(channelTitle('')).toBe('【企业微信】新会话')
  })

  it('renames a channel session after DSH writes a title', async () => {
    const ctx = new Context()
    const rename = vi.fn(async ({ title }: { title: string }) => ({ title, seq: 1 }))
    ctx.provide('sessionController', { rename } as never)
    installChannelTitle(ctx, { warn: vi.fn() })
    ctx.emit('session/event', { id: 'session-wecom-abc' } as never, {
      type: 'session/title', seq: 1, data: { title: '修复登录' },
    } as never)
    await vi.waitFor(() => {
      expect(rename).toHaveBeenCalledWith(expect.objectContaining({ title: '【企业微信】修复登录' }))
    })
    ctx.emit('session/event', { id: 'session-wecom-abc' } as never, {
      type: 'session/title', seq: 2, data: { title: '【企业微信】修复登录' },
    } as never)
    ctx.emit('session/event', { id: 'session-other' } as never, {
      type: 'session/title', seq: 1, data: { title: '别的会话' },
    } as never)
    await Promise.resolve()
    expect(rename).toHaveBeenCalledTimes(1)
    await ctx.fiber.dispose()
  })
})
