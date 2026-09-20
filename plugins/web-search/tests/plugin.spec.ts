import { Context } from '@deepseek-ai/cordis'
import { SystemPrompt } from '@deepseek-ai/dsh-system-prompt'
import { ToolRuntime, type ToolExecutionInput } from '@deepseek-ai/dsh-tools'
import { afterEach, expect, it, vi } from 'vitest'
import * as WebSearch from '../src/index.js'

const contexts: Context[] = []
afterEach(async () => {
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
  vi.unstubAllGlobals()
})

function server(call = async (_params: unknown, _signal?: AbortSignal | null): Promise<object> => ({
  content: [{ type: 'text', text: 'Title: Example\nURL: https://example.com\nText: Public source' }],
})) {
  const requests: Array<{ method: string; params?: unknown }> = []
  const fetch = vi.fn<typeof globalThis.fetch>(async (input, init) => {
    expect(String(input)).toBe(WebSearch.EXA_URL)
    expect(new Headers(init?.headers).has('authorization')).toBe(false)
    if (init?.method !== 'POST') return new Response(null, { status: 405 })
    const request = JSON.parse(String(init.body)) as { id?: number; method: string; params?: unknown }
    requests.push(request)
    if (request.id === undefined) return new Response(null, { status: 202 })
    let result: object
    if (request.method === 'initialize') {
      result = { protocolVersion: '2025-03-26', capabilities: { tools: {} }, serverInfo: { name: 'fixture', version: '1' } }
    } else if (request.method === 'tools/list') {
      result = { tools: ['web_search_exa', 'web_fetch_exa'].map(name => ({
        name, description: name,
        inputSchema: name === 'web_search_exa'
          ? { type: 'object', properties: { query: { type: 'string', minLength: 1 }, objective: { type: 'string', minLength: 1 } }, required: ['query', 'objective'], additionalProperties: false }
          : { type: 'object', properties: { urls: { type: 'array', items: { type: 'string' } } }, required: ['urls'], additionalProperties: false },
      })) }
    } else if (request.method === 'tools/call') result = await call(request.params, init.signal)
    else throw new Error('Unexpected request: ' + request.method)
    return Response.json({ jsonrpc: '2.0', id: request.id, result })
  })
  vi.stubGlobal('fetch', fetch)
  return { requests, fetch }
}

async function mount() {
  const ctx = new Context(); contexts.push(ctx)
  const prompt = await ctx.plugin(SystemPrompt)
  const registry = await prompt.ctx.plugin(ToolRuntime)
  const plugin = await registry.ctx.plugin(WebSearch)
  return { ctx: registry.ctx, plugin }
}

function execute(ctx: Context, args: unknown, name = WebSearch.SEARCH_TOOL, signal = new AbortController().signal) {
  return ctx.tools.execute({ callId: 'web-search-test' as ToolExecutionInput['callId'], name, arguments: args, signal })
}

it('uses the real MCP bridge for search and fetch, and releases tools, prompt and namespace on unload', async () => {
  const remote = server()
  const { ctx, plugin } = await mount()
  expect(ctx.tools.get(WebSearch.SEARCH_TOOL)).toBeDefined()
  expect(ctx.tools.get(WebSearch.FETCH_TOOL)).toBeDefined()
  expect(JSON.stringify(await ctx.systemPrompt.assemble())).toContain('free Exa search')
  const result = await execute(ctx, { query: 'public docs', objective: 'Find the official docs' })
  expect(result.isError).toBe(false)
  expect(JSON.stringify(result)).toContain('https://example.com')
  expect((await execute(ctx, { urls: ['https://example.com'] }, WebSearch.FETCH_TOOL)).isError).toBe(false)
  expect(remote.requests.filter(req => req.method === 'tools/call').map(req => req.params)).toEqual([
    { name: 'web_search_exa', arguments: { query: 'public docs', objective: 'Find the official docs' } },
    { name: 'web_fetch_exa', arguments: { urls: ['https://example.com'] } },
  ])
  await plugin.dispose()
  expect(ctx.tools.get(WebSearch.SEARCH_TOOL)).toBeUndefined()
  expect(ctx.tools.get(WebSearch.FETCH_TOOL)).toBeUndefined()
  expect(JSON.stringify(await ctx.systemPrompt.assemble())).not.toContain('free Exa search')
  const reloaded = await ctx.plugin(WebSearch)
  expect(ctx.tools.get(WebSearch.SEARCH_TOOL)).toBeDefined()
  await reloaded.dispose()
})

it('rejects invalid arguments before sending a remote search', async () => {
  const remote = server()
  const { ctx } = await mount()
  expect((await execute(ctx, { query: '' })).isError).toBe(true)
  expect(remote.requests.filter(req => req.method === 'tools/call')).toHaveLength(0)
})

it('surfaces rate limits as tool errors without using another search service', async () => {
  const remote = server(async () => ({ isError: true, content: [{ type: 'text', text: '429 rate limit' }] }))
  const { ctx } = await mount()
  const result = await execute(ctx, { query: 'public docs', objective: 'Find official docs' })
  expect(result.isError).toBe(true)
  expect(JSON.stringify(result)).toContain('429 rate limit')
  expect(remote.requests.filter(req => req.method === 'tools/call')).toHaveLength(1)
})

it('sends MCP cancellation and closes the pending transport on unload', async () => {
  let enter!: () => void
  let cancel!: () => void
  const entered = new Promise<void>(resolve => { enter = resolve })
  const cancelled = new Promise<void>(resolve => { cancel = resolve })
  const remote = server(async (_params, signal) => await new Promise((_resolve, reject) => {
    const abort = () => { cancel(); reject(signal?.reason) }
    if (signal?.aborted) abort()
    else signal?.addEventListener('abort', abort, { once: true })
    enter()
  }))
  const { ctx, plugin } = await mount()
  const controller = new AbortController()
  const pending = execute(ctx, { query: 'public docs', objective: 'Find docs' }, WebSearch.SEARCH_TOOL, controller.signal)
  await entered
  controller.abort()
  const result = await pending
  expect(remote.requests.some(request => request.method === 'notifications/cancelled')).toBe(true)
  await plugin.dispose()
  await cancelled
  expect(result.isError).toBe(true)
})

it('keeps the host usable when the free endpoint is unavailable', async () => {
  vi.stubGlobal('fetch', vi.fn<typeof fetch>(async () => { throw new Error('offline') }))
  const { ctx, plugin } = await mount()
  expect(ctx.tools.get(WebSearch.SEARCH_TOOL)).toBeUndefined()
  expect(JSON.stringify(await ctx.systemPrompt.assemble())).not.toContain('free Exa search')
  await plugin.dispose()
})
