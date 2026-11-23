import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { apply } from '../src/agent-workspace.ts'
import { latestAgentState } from '../src/agent-contract.ts'

const transport = vi.hoisted(() => ({ handler: undefined }))
vi.mock('../src/web.ts', () => ({ registerRpc: (_ctx, _channel, handler) => { transport.handler = handler } }))

it('accepts a restarted workspace instead of permanently displaying the old higher revision', () => {
  const before = { sessionId: 'same-session', generation: 'old', revision: 30, title: 'Old result' }
  const restarted = { ...before, generation: 'new', revision: 1, title: 'Current result' }
  expect(latestAgentState(before, restarted)).toBe(restarted)
  expect(latestAgentState(before, { ...before, revision: 29 })).toBe(before)
})

it('rejects invalid model parameters without failing or replacing the last workspace state', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'saas-agent-state-')), siteFile = join(directory, 'site.json')
  const tools = new Map(), disposers = [], service = { read: vi.fn(), sessionState: () => undefined }
  const ctx = { on: () => () => {}, agents: { get: () => undefined }, get: () => service, effect: fn => { disposers.push(fn()) }, tools: { register: tool => tools.set(tool.name, tool) },
    webServer: { register: () => () => {} }, systemPrompt: { section: () => {} } }
  await writeFile(siteFile, JSON.stringify({ name: 'Fixture', url: 'https://portal.example.test/agents', allowedOrigins: ['https://portal.example.test'], emptyText: 'Empty',
    selectors: Object.fromEntries(['search', 'results', 'card', 'name', 'type', 'version', 'tags', 'description'].map(key => [key, '.' + key])) }))
  try {
    await apply(ctx, { siteFile })
    const signal = new AbortController().signal
    const state = () => transport.handler('state', { sessionId: 'fixture' }, signal)
    const before = structuredClone(await state())
    await expect(tools.get('saas_browser').execute({ action: 'scroll', delta: -2000 }, { agent: { session: { id: 'fixture' } }, signal })).rejects.toThrow()
    expect(await state()).toEqual(before)
    expect(service.read).not.toHaveBeenCalled()
  } finally {
    for (const dispose of disposers.reverse()) if (typeof dispose === 'function') await dispose()
    await rm(directory, { recursive: true, force: true })
  }
})
