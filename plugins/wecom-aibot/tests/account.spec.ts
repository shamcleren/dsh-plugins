import { EventEmitter } from 'node:events'
import type { Logger } from '@deepseek-ai/cordis'
import { EventType } from '@wecom/aibot-node-sdk'
import type { EventMessageWith, TemplateCardEventData, WsFrame } from '@wecom/aibot-node-sdk'
import { describe, expect, it, vi } from 'vitest'
import { WeComBotAccount, type WeComBotClient } from '../src/account.js'

class FakeClient extends EventEmitter implements WeComBotClient {
  connect = vi.fn()
  disconnect = vi.fn()
}

function logger(): Logger {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    success: vi.fn(),
  } as unknown as Logger
}

describe('WeComBotAccount', () => {
  it('owns one connection lifecycle idempotently', () => {
    const client = new FakeClient()
    const account = new WeComBotAccount(client, logger(), vi.fn(), vi.fn())

    account.start()
    account.start()
    expect(client.connect).toHaveBeenCalledTimes(1)
    expect(client.listenerCount('authenticated')).toBe(1)
    expect(client.listenerCount('disconnected')).toBe(1)
    expect(client.listenerCount('error')).toBe(1)
    expect(client.listenerCount('message.text')).toBe(1)
    expect(client.listenerCount('event.template_card_event')).toBe(1)

    account.stop()
    account.stop()
    expect(client.disconnect).toHaveBeenCalledTimes(1)
    expect(client.eventNames()).toEqual([])
  })

  it('projects connection diagnostics without message content', () => {
    const client = new FakeClient()
    const sink = logger()
    const account = new WeComBotAccount(client, sink, vi.fn(), vi.fn())
    account.start()

    const failure = new Error('connection failed')
    client.emit('authenticated')
    client.emit('disconnected', 'network')
    client.emit('error', failure)

    expect(sink.info).toHaveBeenCalledWith('WeCom Bot authenticated')
    expect(sink.warn).toHaveBeenCalledWith('WeCom Bot disconnected: %s', 'network')
    expect(sink.error).toHaveBeenCalledWith(failure)
  })

  it('forwards template-card events to the channel router callback', () => {
    const client = new FakeClient()
    const onTemplateCardEvent = vi.fn()
    const account = new WeComBotAccount(client, logger(), vi.fn(), onTemplateCardEvent)
    const frame: WsFrame<EventMessageWith<TemplateCardEventData>> = {
      headers: { req_id: 'card-event' },
      body: {
        msgid: 'card-message', create_time: 1, aibotid: 'bot-1', chattype: 'single',
        from: { userid: 'user-1' }, msgtype: 'event',
        event: {
          eventtype: EventType.TemplateCardEvent,
          event_key: 'approval_allow',
          task_id: 'wecom_approval_task',
        },
      },
    }
    account.start()

    client.emit('event.template_card_event', frame)

    expect(onTemplateCardEvent).toHaveBeenCalledWith(frame)
  })

  it('cleans up a failed connection attempt and remains restartable', () => {
    const client = new FakeClient()
    client.connect.mockImplementationOnce(() => {
      throw new Error('invalid credentials')
    })
    const account = new WeComBotAccount(client, logger(), vi.fn(), vi.fn())

    expect(() => account.start()).toThrow('invalid credentials')
    expect(client.eventNames()).toEqual([])

    account.start()
    expect(client.connect).toHaveBeenCalledTimes(2)
    expect(client.listenerCount('authenticated')).toBe(1)
  })
})
