import { describe, expect, it } from 'vitest'
import { contextUsage, projectItem, projectTurn, quotaUsage, safeJson } from '../src/activity.ts'
import { upsertActivity, emptyRecord } from '../src/journal.ts'

describe('Codex activity projection', () => {
  it('keeps known items and degrades duplicates into one card', () => {
    const started = projectItem('item/started', { item: { id: 'cmd-1', type: 'commandExecution', command: 'git status', status: 'inProgress' } })
    const completed = projectItem('item/completed', { item: { id: 'cmd-1', type: 'commandExecution', command: 'git status', aggregatedOutput: 'clean', status: 'completed' } })
    expect(started?.kind).toBe('commandExecution')
    const record = upsertActivity(upsertActivity(emptyRecord('s1'), started!), completed!)
    expect(record.activities).toHaveLength(1)
    expect(record.activities[0]?.detail).toContain('clean')
  })

  it('projects plan and diff, and redacts secrets without a usage card', () => {
    expect(projectTurn('turn/plan/updated', { plan: [{ step: 'read', status: 'pending' }] })?.kind).toBe('plan')
    expect(projectTurn('turn/diff/updated', { diff: 'diff --git a/a b/a' })?.detail).toContain('diff --git')
    expect(projectTurn('thread/tokenUsage/updated', { total: { input: 1 } })).toBeUndefined()
    expect(contextUsage({ tokenUsage: { last: { totalTokens: 5168 }, modelContextWindow: 258400 } })).toEqual({ used: 5168, window: 258400, percent: 2 })
    expect(contextUsage({ tokenUsage: { last: { totalTokens: 10 } } })).toBeUndefined()
    expect(projectItem('item/completed', { item: { id: 'msg-1', type: 'userMessage', status: 'completed' } })).toBeUndefined()
    expect(quotaUsage({ rateLimits: { primary: { usedPercent: 9, resetsAt: 1_700_000_000 }, secondary: { usedPercent: 40 } } })).toEqual({ remaining: 60 })
    expect(quotaUsage({ rateLimits: { primary: { usedPercent: 9, resetsAt: 1_700_000_000, windowDurationMins: 300 } } })).toEqual({ remaining: 91, resetsAt: 1_700_000_000_000, windowMinutes: 300 })
    expect(quotaUsage({ rateLimits: { credits: { balance: 1 } } })).toBeUndefined()
    expect(safeJson({ token: 'secret-value', note: 'ok' })).toContain('[redacted]')
    expect(safeJson({ token: 'secret-value' })).not.toContain('secret-value')
  })
})
