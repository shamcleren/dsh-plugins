import { describe, expect, it, vi } from 'vitest'
import { ensureConversationSession } from '../../src/core/sessions.js'
import type { HostApiProxy, RpcRequest } from '../../src/core/host-api.js'

function fixture(options: { existing?: boolean; archived?: boolean } = {}) {
  const workspace = { workspaceId: 'fixture-workspace', title: 'Fixture', path: '/fixture', sessionIds: options.existing ? ['session-wechat-fixture'] : [] }
  const list = vi.fn(async (request: RpcRequest<object>) => ({ rpcId: request.rpcId, result: { ok: true as const, value: { items: [workspace], archivedSessionIds: options.archived ? ['session-wechat-fixture'] : [] } } }))
  const history = vi.fn(async (request: RpcRequest<object>) => ({ rpcId: request.rpcId, result: { ok: true as const, value: { events: [{ event: { type: 'turn/start', seq: 1, data: {} } }], hasMore: false } } }))
  const api = { workspace: { list }, sessions: { history } }
  const create = vi.fn(async () => 'session-host-minted'), set = vi.fn(async () => {})
  const input = { api, key: 'fixture-chat', requested: 'session-wechat-fixture', defaultWorkspaceId: 'fixture-workspace', bindings: { set }, create }
  return { input, create, set, history }
}
describe('shared IM session ownership', () => {
  it('continues an existing conversation without creating another model session', async () => {
    const { input, create, set } = fixture({ existing: true })
    await expect(ensureConversationSession(input)).resolves.toBe('session-wechat-fixture')
    expect(create).not.toHaveBeenCalled(); expect(set).not.toHaveBeenCalled()
  })
  it('persists the identity actually minted by the public Host controller', async () => {
    const { input, set } = fixture()
    await expect(ensureConversationSession(input)).resolves.toBe('session-host-minted')
    expect(set).toHaveBeenCalledWith('fixture-chat', 'session-host-minted')
  })
  it('starts a fresh conversation for an archived binding', async () => {
    const { input, create, history } = fixture({ existing: true, archived: true })
    await ensureConversationSession(input)
    expect(create).toHaveBeenCalledWith(expect.not.stringMatching(/^session-wechat-fixture$/), 'fixture-workspace')
    expect(history).not.toHaveBeenCalled()
  })
})
