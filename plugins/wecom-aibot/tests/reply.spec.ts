import { describe, expect, it } from 'vitest'
import { boundReply, TurnProjection } from '../src/reply.js'

describe('WeCom reply projection', () => {
  it('bounds multibyte text without cutting a code point', () => {
    expect(boundReply('你a好', 4)).toBe('你a')
  })

  it('keeps assistant text from earlier steps in later stream updates', () => {
    const projection = new TurnProjection('prompt-1')
    projection.push({
      type: 'agent/inbox/spliced', seq: 1,
      data: { inserted: [{ source: { rpcId: 'prompt-1' } }] },
    })
    projection.push({ type: 'turn/start', seq: 2, data: { turn: 1 } })
    projection.push({ type: 'step/start', seq: 3, data: { turn: 1, step: 1 } })
    expect(projection.push({
      type: 'assistant/chunk', seq: 4,
      data: { turn: 1, chunk: { type: 'text-delta', index: 0, text: '第一段' } },
    }).partial).toBe('第一段')
    projection.push({ type: 'step/start', seq: 5, data: { turn: 1, step: 2 } })
    expect(projection.push({
      type: 'assistant/chunk', seq: 6,
      data: { turn: 1, chunk: { type: 'text-delta', index: 0, text: '第二段' } },
    }).partial).toBe('第一段\n\n第二段')
    expect(projection.push({
      type: 'turn/end', seq: 7, data: { turn: 1, reason: { kind: 'completed' } },
    }).outcome?.text).toBe('第一段\n\n第二段')
  })
})
