import { describe, expect, it } from 'vitest'
import { approvalPrompt, approvalResponse, decisionFor, ELICITATION, nativelyApprovable } from '../src/approval-map.ts'

describe('DSH approval mapping', () => {
  it('maps the closed vocabulary and never invents a session grant', () => {
    expect(decisionFor('allowed-once')).toBe('accept')
    expect(decisionFor('rejected')).toBe('decline')
    expect(decisionFor('cancelled')).toBe('cancel')
    expect(decisionFor('unavailable')).toBe('decline')
    expect(JSON.stringify(approvalResponse('item/commandExecution/requestApproval', {}, 'accept'))).not.toContain('acceptForSession')
  })

  it('echoes only the requested permission subset for the current turn', () => {
    const params = { permissions: { network: true, all: false }, reason: 'fetch docs' }
    expect(approvalResponse('item/permissions/requestApproval', params, 'accept')).toEqual({ permissions: { network: true, all: false }, scope: 'turn' })
    expect(approvalResponse('item/permissions/requestApproval', params, 'decline')).toEqual({ permissions: {}, scope: 'turn' })
    expect(approvalPrompt('item/commandExecution/requestApproval', { command: 'git status' }).toolName).toBe('codex.command')
  })

  it('answers a confirmation-only elicitation natively and leaves field requests to the caller', () => {
    const confirmation = { message: 'Allow Computer Use to use "DeepSeek Harness"?' }
    expect(nativelyApprovable(ELICITATION, confirmation)).toBe(true)
    expect(nativelyApprovable(ELICITATION, { ...confirmation, requestedSchema: { type: 'object', properties: {} } })).toBe(true)
    expect(nativelyApprovable(ELICITATION, { ...confirmation, requestedSchema: { type: 'object', properties: { token: { type: 'string' } } } })).toBe(false)
    expect(nativelyApprovable('item/tool/requestUserInput', { questions: [{ id: 'name' }] })).toBe(false)
    expect(approvalPrompt(ELICITATION, confirmation)).toEqual({ toolName: 'codex.mcpElicitation', reason: confirmation.message })
    expect(approvalResponse(ELICITATION, confirmation, 'accept')).toEqual({ action: 'accept', content: {} })
    expect(approvalResponse(ELICITATION, confirmation, 'decline')).toEqual({ action: 'decline' })
    expect(approvalResponse(ELICITATION, confirmation, 'cancel')).toEqual({ action: 'cancel' })
  })
})
