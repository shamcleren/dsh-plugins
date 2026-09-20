/** Opt-in live check of built (or unpacked release) code using real DSH services. */
import assert from 'node:assert/strict'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import { SystemPrompt } from '@deepseek-ai/dsh-system-prompt'
import { ToolRuntime } from '@deepseek-ai/dsh-tools'

const plugin = await import(process.argv[2] ? pathToFileURL(resolve(process.argv[2])).href : '../lib/index.js')
const ctx = new Context()
try {
  const prompt = await ctx.plugin(SystemPrompt)
  const registry = await prompt.ctx.plugin(ToolRuntime)
  const mounted = await registry.ctx.plugin(plugin)
  const tools = registry.ctx.tools
  for (const name of [plugin.SEARCH_TOOL, plugin.FETCH_TOOL]) assert.ok(tools.get(name), `Missing tool: ${name}`)
  for (const [name, args] of [
    [plugin.SEARCH_TOOL, { query: 'TypeScript official release notes', objective: 'Find official TypeScript documentation and return source URLs', numResults: 3 }],
    [plugin.FETCH_TOOL, { urls: ['https://www.typescriptlang.org/docs/'], maxCharacters: 1000 }],
  ]) {
    const result = await tools.execute({ callId: name, name, arguments: args, signal: AbortSignal.timeout(35_000) })
    assert.equal(result.isError, false, JSON.stringify(result))
    assert.match(JSON.stringify(result), /typescriptlang\.org/)
    console.log(`${name}: passed (public TypeScript sources returned)`)
  }
  await mounted.dispose()
  assert.equal(tools.get(plugin.SEARCH_TOOL), undefined)
  assert.equal(tools.get(plugin.FETCH_TOOL), undefined)
  console.log('unload: passed')
} finally {
  await ctx.fiber.dispose()
}
