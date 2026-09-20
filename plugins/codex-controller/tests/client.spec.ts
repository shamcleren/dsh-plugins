import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { BadgeView, QuotaView, apply, resetLabel } from '../src/client/index.ts'
import { zh } from '../src/client/locales.ts'
import { codexNoticeDefinition, codexViewDefinition } from '../src/conversation.ts'
import { emptyRecord } from '../src/journal.ts'
import { CODEX_CHANNEL } from '../src/ui-contract.ts'

const t = (key: keyof typeof zh) => zh[key]

describe('Codex session UI', () => {
  it('adds a Codex header without an activity dock', () => {
    const slots = vi.fn((_slot: string, callback: () => void) => callback())
    const register = vi.fn()
    const events = vi.fn(() => () => {})
    const views = vi.fn(() => () => {})
    apply({ effect: callback => { callback() }, locale: { register: vi.fn(), bind: () => t }, connection: { rpc: { call: vi.fn() } }, sessions: { open: vi.fn(), list: { getSnapshot: () => ({ current: 's1', byId: { s1: { cwd: '/work' } } }) } }, uiConversation: { events: { register: events }, views: { register: views } }, slots: { inject: slots, register } })
    expect(slots.mock.calls.map(call => call[0])).toEqual(['conversation.session.header.actions'])
    expect(register.mock.calls.map(call => call[0].id)).toEqual(['codex-controller-badge'])
    expect(slots.mock.calls.map(call => call[0])).not.toContain('conversation.input.dock')
    expect(events).toHaveBeenCalledOnce()
    expect(views).toHaveBeenCalledOnce()
    expect(CODEX_CHANNEL).toBe('/codex-controller')
    expect(slots.mock.calls.map(call => call[0])).not.toContain('shell.overlay')
  })

  it('shows remaining quota in the header and not context fill or activity cards', () => {
    const record = emptyRecord('s1')
    record.threadId = 'thread-abcdef'
    record.usage = { used: 5168, window: 258400, percent: 9 }
    const quota = { remaining: 91, resetsAt: Date.UTC(2026, 8, 14, 18, 0, 0) }
    const header = renderToStaticMarkup(createElement(BadgeView, { state: { present: true, record, quota }, t }))
    const other = renderToStaticMarkup(createElement(BadgeView, { state: { present: true, record: emptyRecord('s2'), quota }, t }))
    expect(header).toContain('Codex')
    expect(header).toContain('codex-mark')
    expect(header).toContain('title="Codex · thread-a"')
    expect(header).not.toContain('>thread-a')
    expect(header).toContain('使用情况')
    expect(header).toContain('剩余 91%')
    expect(header).toContain('重置 ' + resetLabel(quota.resetsAt, 'Asia/Shanghai'))
    expect(other).toContain('剩余 91%')
    expect(header).not.toContain('9%')
    expect(header).not.toContain('5168 / 258400')
    expect(header).not.toContain('codex-dock')
    expect(renderToStaticMarkup(createElement(BadgeView, { state: { present: false, record, quota }, t }))).toBe('')
    expect(renderToStaticMarkup(createElement(QuotaView, { state: { present: false, record, quota }, t }))).toBe('')
  })

  it('projects plugin notices into conversation nodes and ignores other messages', () => {
    const definition = codexNoticeDefinition()
    const notice = { type: 'user/message', seq: 4, data: { source: { kind: 'plugin', plugin: 'codex-controller', summary: '命令' }, content: [{ type: 'text', text: 'ls' }] } }
    expect(definition.match(notice as never)?.id).toBe('codex-notice:4')
    expect(definition.match({ type: 'user/message', seq: 5, data: { source: { kind: 'user' }, content: [{ type: 'text', text: 'hello' }] } } as never)).toBeNull()
    const view = codexViewDefinition().create()
    const node = definition.buildViewNode?.({ key: 'k', kind: 'codex-notice', id: 'codex-notice:4', state: { summary: '命令', text: 'ls', seq: 4 }, matches: [], start: undefined, current: new Map() })
    expect(view.apply({ upserts: node ? [node] : [], timeline: { turnOrder: [], turns: new Map() } }).nodes[0]?.text).toBe('ls')
  })
})
