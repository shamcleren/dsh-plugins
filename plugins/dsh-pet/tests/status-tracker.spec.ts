import { describe, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import { PetStatusTracker } from '../src/status.js'
import type { PetDisplay } from '../src/shared/state.js'

type Handler = (...args: any[]) => unknown

/** Minimal event-bus mock that captures every `ctx.on` subscription. */
function makeCtx(): { ctx: Context, handlers: Map<string, Handler> } {
  const handlers = new Map<string, Handler>()
  const ctx = {
    on(event: string, handler: Handler) {
      handlers.set(event, handler)
      return () => handlers.delete(event)
    },
  } as unknown as Context
  return { ctx, handlers }
}

const session = { id: 's1', header: { cwd: '/tmp/proj' } } as unknown as Session

function turn(handlers: Map<string, Handler>, event: SessionEvent): void {
  const handler = handlers.get('session/event')
  handler?.(session, event)
}

function turnOn(handlers: Map<string, Handler>, target: Session, event: SessionEvent): void {
  const handler = handlers.get('session/event')
  handler?.(target, event)
}

function endTurn(handlers: Map<string, Handler>, kind: string): void {
  turn(handlers, { type: 'turn/end', data: { reason: { kind } } } as unknown as SessionEvent)
}

function endTurnOn(handlers: Map<string, Handler>, target: Session, kind: string): void {
  turnOn(handlers, target, { type: 'turn/end', data: { reason: { kind } } } as unknown as SessionEvent)
}

describe('PetStatusTracker state machine', () => {
  it('starts idle', () => {
    const { ctx, handlers } = makeCtx()
    const tracker = new PetStatusTracker(ctx)
    const displays: PetDisplay[] = []
    tracker.start(display => displays.push(display))
    expect(tracker.currentDisplay()).toEqual({ state: 'idle', bubble: null, tasks: [] })
    tracker.dispose()
    void handlers
  })

  it('holds review after a completed turn until the next turn', () => {
    const { ctx, handlers } = makeCtx()
    const tracker = new PetStatusTracker(ctx)
    tracker.start(() => {})
    endTurn(handlers, 'completed')
    expect(tracker.currentDisplay().state).toBe('review')
    // A new turn clears the sticky "ready" state and enters Running.
    turn(handlers, { type: 'turn/start', data: {} } as unknown as SessionEvent)
    expect(tracker.currentDisplay().state).toBe('running')
    tracker.dispose()
  })

  it('holds failed after an error turn until the next turn', () => {
    const { ctx, handlers } = makeCtx()
    const tracker = new PetStatusTracker(ctx)
    tracker.start(() => {})
    endTurn(handlers, 'error')
    expect(tracker.currentDisplay().state).toBe('failed')
    // A new turn clears the sticky "blocked" state and enters Running.
    turn(handlers, { type: 'turn/start', data: {} } as unknown as SessionEvent)
    expect(tracker.currentDisplay().state).toBe('running')
    tracker.dispose()
  })

  it('prioritizes needs-input over ready and blocked', async () => {
    const { ctx, handlers } = makeCtx()
    const tracker = new PetStatusTracker(ctx)
    tracker.start(() => {})
    endTurn(handlers, 'completed')
    expect(tracker.currentDisplay().state).toBe('review')

    // Open a user question → needs input wins over ready.
    const requestHandler = handlers.get('user-questions/request')!
    let release!: () => void
    const pending = requestHandler({ agent: { id: 'a1' } }, () => new Promise<void>(resolve => {
      release = resolve
    }))
    expect(tracker.currentDisplay().state).toBe('waiting')
    release()
    await pending
    expect(tracker.currentDisplay().state).toBe('review')
    tracker.dispose()
  })

  it('lists one task row per concurrent session', () => {
    const { ctx, handlers } = makeCtx()
    const tracker = new PetStatusTracker(ctx)
    tracker.start(() => {})
    const s2 = { id: 's2', header: { cwd: '/tmp/other' } } as unknown as Session

    // s1 completes a turn → ready; s2 errors → blocked.
    endTurn(handlers, 'completed')
    endTurnOn(handlers, s2, 'error')

    const display = tracker.currentDisplay()
    // Needs input > Blocked > Ready: s2 (failed) sorts before s1 (review).
    expect(display.state).toBe('failed')
    expect(display.tasks.map(task => task.id)).toEqual(['s2', 's1'])
    expect(display.tasks[0]!.state).toBe('failed')
    expect(display.tasks[1]!.state).toBe('review')
    tracker.dispose()
  })

  it('sorts concurrent tasks by Codex priority then recency', () => {
    const { ctx, handlers } = makeCtx()
    const tracker = new PetStatusTracker(ctx)
    tracker.start(() => {})
    const s2 = { id: 's2', header: { cwd: '/tmp/other' } } as unknown as Session

    // Both ready; s2 completed later (higher updatedAt) sorts first.
    endTurn(handlers, 'completed')
    endTurnOn(handlers, s2, 'completed')

    const display = tracker.currentDisplay()
    expect(display.state).toBe('review')
    expect(display.tasks.map(task => task.id)).toEqual(['s2', 's1'])
    tracker.dispose()
  })

  it('treats a blocked turn as needs-input', () => {
    const { ctx, handlers } = makeCtx()
    const tracker = new PetStatusTracker(ctx)
    tracker.start(() => {})
    endTurn(handlers, 'blocked')
    expect(tracker.currentDisplay().state).toBe('waiting')
    expect(tracker.currentDisplay().tasks[0]!.state).toBe('waiting')
    tracker.dispose()
  })

  it('uses the human request as the stable title and shows concrete progress', () => {
    const { ctx, handlers } = makeCtx()
    let now = 1_000_000
    const tracker = new PetStatusTracker(ctx, () => now)
    tracker.start(() => {})

    turn(handlers, { type: 'turn/start', data: { turn: 1 } } as unknown as SessionEvent)
    turn(handlers, {
      type: 'user/message',
      data: {
        id: 'm1',
        role: 'user',
        source: { kind: 'user' },
        content: [{ type: 'text', text: '优化桌面宠物的状态展示' }],
      },
    } as unknown as SessionEvent)
    turn(handlers, {
      type: 'todo/write',
      data: {
        todos: [
          { content: '梳理状态文案', status: 'completed' },
          { content: '验证原生卡片布局', status: 'in_progress' },
        ],
      },
    } as unknown as SessionEvent)
    now += 40_000

    const task = tracker.currentDisplay().tasks[0]!
    expect(task.title).toBe('优化桌面宠物的状态展示')
    expect(task.summary).toBe('当前：验证原生卡片布局')
    expect(task.detail).toBe('proj · 1/2 步 · 已运行 40 秒')
    expect(task.action).toBe('查看进度')
    tracker.dispose()
  })

  it('shows the exact user question as the required action', async () => {
    const { ctx, handlers } = makeCtx()
    const tracker = new PetStatusTracker(ctx)
    tracker.start(() => {})
    const requestHandler = handlers.get('user-questions/request')!
    let release!: () => void
    const pending = requestHandler({
      agent: { id: 'a1' },
      questions: [{ question: '是否允许重启桌面客户端？' }],
    }, () => new Promise<void>(resolve => { release = resolve }))

    const task = tracker.currentDisplay().tasks[0]!
    expect(task.stage).toBe('需要确认')
    expect(task.summary).toBe('是否允许重启桌面客户端？')
    expect(task.action).toBe('去处理')
    release()
    await pending
    tracker.dispose()
  })

  it('shows a bounded failure reason and keeps failure visible', () => {
    const { ctx, handlers } = makeCtx()
    const tracker = new PetStatusTracker(ctx)
    tracker.start(() => {})
    turn(handlers, {
      type: 'turn/end',
      data: { reason: { kind: 'error', error: { message: '连接模型服务超时', code: 'TIMEOUT' } } },
    } as unknown as SessionEvent)

    const task = tracker.currentDisplay().tasks[0]!
    expect(task.state).toBe('failed')
    expect(task.summary).toBe('连接模型服务超时')
    expect(task.action).toBe('查看原因')
    tracker.dispose()
  })

  it('clears a completed row only after the user opens it', () => {
    const { ctx, handlers } = makeCtx()
    const tracker = new PetStatusTracker(ctx)
    tracker.start(() => {})
    endTurn(handlers, 'completed')
    expect(tracker.currentDisplay().tasks[0]!.action).toBe('查看结果')

    tracker.acknowledge('s1')
    expect(tracker.currentDisplay()).toEqual({ state: 'idle', bubble: null, tasks: [] })
    tracker.dispose()
  })
})
