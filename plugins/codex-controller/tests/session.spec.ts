import { mkdtemp } from 'node:fs/promises'
import { createInterface } from 'node:readline'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { describe, expect, it } from 'vitest'
import { CodexAdapter } from '../src/adapter.ts'
import { CodexBridge, type BridgeHost } from '../src/bridge.ts'
import { registerDelegate } from '../src/delegate.ts'
import { readRecord, writeRecord } from '../src/journal.ts'
import { localTitle, threadIdFromSession, turnText } from '../src/transcript.ts'

function host(root: string, spawn: BridgeHost['spawn'], extras: Partial<BridgeHost> = {}): BridgeHost {
  return {
    root,
    spawn,
    session: () => undefined,
    agent: () => undefined,
    approve: async () => 'rejected',
    saveImage: async (_data, name) => ({ attachmentId: 'image-id' as never, mediaType: 'image/png', bytes: 8, width: 1, height: 1, name }),
    imageInput: async () => ({ type: 'localImage', path: '/stored/input.png' }),
    ...extras,
  }
}

interface ServerOptions {
  failResume?: boolean
  image?: boolean
  agentText?: string
  /** One server-initiated request issued mid-turn, with the client's reply captured. */
  ask?: { method: string; params: object }
}

function acceptingServer(threadId: string, options: ServerOptions = {}) {
  const stdin = new PassThrough()
  const stdout = new PassThrough()
  let terminated = false
  const done = Promise.withResolvers<{ exitCode: number | null; signal: NodeJS.Signals | null }>()
  const answered = Promise.withResolvers<unknown>()
  const turnInputs: unknown[] = []
  const lines = createInterface({ input: stdin })
  const notify = (method: string, params: object) => stdout.write(JSON.stringify({ method, params }) + '\n')
  const complete = () => notify('turn/completed', { turn: { status: 'completed' } })
  lines.on('line', (line: string) => {
    const frame = JSON.parse(line) as { id?: string; method?: string; params?: { input?: unknown }; result?: unknown }
    if (frame.method === undefined && frame.id === 'ask-1') { answered.resolve(frame.result); complete(); return }
    const reply = (result: unknown) => stdout.write(JSON.stringify({ id: frame.id, result }) + '\n')
    if (frame.method === 'initialize') reply({ userAgent: 'fake' })
    else if (frame.method === 'thread/resume' && options.failResume) stdout.write(JSON.stringify({ id: frame.id, error: { code: 1, message: 'gone' } }) + '\n')
    else if (frame.method === 'thread/resume') reply({ thread: { id: threadId } })
    else if (frame.method === 'thread/start') reply({ thread: { id: threadId } })
    else if (frame.method === 'turn/start') {
      turnInputs.push(frame.params?.input)
      reply({ turn: { id: 'turn' } })
      if (options.image) {
        const item = { type: 'imageGeneration', id: 'image-1', status: 'completed', revisedPrompt: 'a dot', result: 'iVBORw0KGgo=', savedPath: '/tmp/generated.png' }
        notify('item/completed', { item })
        notify('item/completed', { item })
      }
      const agentText = options.agentText ?? 'ok'
      if (agentText) notify('item/agentMessage/delta', { delta: agentText })
      if (options.ask) stdout.write(JSON.stringify({ id: 'ask-1', method: options.ask.method, params: options.ask.params }) + '\n')
      else complete()
    } else if (frame.id !== undefined) reply({})
  })
  return { stdin, stdout, done: done.promise, answered: answered.promise, turnInputs, terminate() { terminated = true; done.resolve({ exitCode: null, signal: 'SIGTERM' }) }, async waitForExit() { return terminated } }
}

describe('Codex session bridge', () => {
  it('maps one session to one thread and resumes it', async () => {
    const root = await mkdtemp(join(tmpdir(), 'codex-session-'))
    const bridge = new CodexBridge(host(root, () => acceptingServer('thread-a')))
    const chunks: string[] = []
    const first = await bridge.run({ sessionId: 'alpha', cwd: '/work', text: 'one', signal: new AbortController().signal, onChunk: chunk => { if (chunk.type === 'text-delta') chunks.push(chunk.text) } })
    expect(first.status).toBe('completed')
    expect((await readRecord(root, 'alpha'))?.threadId).toBe('thread-a')
    expect(chunks.join('')).toBe('ok')
    const resumed = new CodexBridge(host(root, () => acceptingServer('thread-a')))
    await resumed.run({ sessionId: 'alpha', cwd: '/work', text: 'two', signal: new AbortController().signal, onChunk: () => {} })
    expect((await readRecord(root, 'alpha'))?.threadId).toBe('thread-a')
    await bridge.close()
    await resumed.close()
  })

  it('projects one completed image as a native assistant image block', async () => {
    const root = await mkdtemp(join(tmpdir(), 'codex-image-'))
    const saved: Array<{ bytes: number; name: string }> = []
    const bridge = new CodexBridge(host(root, () => acceptingServer('thread-image', { image: true, agentText: '' }), {
      saveImage: async (data, name) => {
        saved.push({ bytes: data.byteLength, name })
        return { attachmentId: 'stored-image' as never, mediaType: 'image/png', bytes: data.byteLength, width: 1, height: 1, name }
      },
    }))
    const chunks: Array<Record<string, unknown>> = []
    const end = await bridge.run({ sessionId: 'image', cwd: '/work', text: 'draw', signal: new AbortController().signal, onChunk: chunk => { chunks.push(chunk) } })
    expect(end.status).toBe('completed')
    expect(saved).toEqual([{ bytes: 8, name: 'generated.png' }])
    expect(chunks.filter(chunk => chunk.type === 'block-end' && (chunk.block as { type?: string })?.type === 'image')).toHaveLength(1)
    expect(chunks.some(chunk => chunk.type === 'block-end' && (chunk.block as { type?: string })?.type === 'text')).toBe(false)
    expect(chunks.at(-1)).toMatchObject({ type: 'finish', reason: { kind: 'stop' } })
    await bridge.close()
  })

  it('forwards an image-only DSH prompt as a Codex local image input', async () => {
    const root = await mkdtemp(join(tmpdir(), 'codex-input-image-'))
    const server = acceptingServer('thread-input-image')
    const bridge = new CodexBridge(host(root, () => server))
    const adapter = new CodexAdapter(bridge, () => '/work')
    const attachment = { attachmentId: 'input-image' as never, mediaType: 'image/png' as const, bytes: 8, width: 1, height: 1 }
    const messages = [{ role: 'user', source: { kind: 'user' }, content: [{ type: 'image', attachment }] }]
    for await (const _chunk of adapter.stream({ sessionId: 'input-image', messages, model: 'native', provider: 'codex' } as never)) {
      // Consume the complete turn so the app-server boundary is observable.
    }
    expect(server.turnInputs).toEqual([[{ type: 'localImage', path: '/stored/input.png' }]])
    await bridge.close()
  })

  it('answers a confirmation-only MCP elicitation through native DSH approval', async () => {
    const root = await mkdtemp(join(tmpdir(), 'codex-elicit-'))
    const asked: string[] = []
    const server = acceptingServer('thread-elicit', { ask: { method: 'mcpServer/elicitation/request', params: { message: 'Allow Computer Use?' } } })
    const bridge = new CodexBridge(host(root, () => server, {
      agent: () => ({}) as never,
      approve: async (_agent, toolName, reason) => { asked.push(toolName + ':' + reason); return 'allowed-once' },
    }))
    const end = await bridge.run({ sessionId: 'elicit', cwd: '/work', text: 'go', signal: new AbortController().signal, onChunk: () => {} })
    expect(end.status).toBe('completed')
    expect(asked).toEqual(['codex.mcpElicitation:Allow Computer Use?'])
    expect(await server.answered).toEqual({ action: 'accept', content: {} })
    await bridge.close()
  })

  it('declines an elicitation that wants typed field values instead of blocking the turn', async () => {
    const root = await mkdtemp(join(tmpdir(), 'codex-elicit-'))
    const notices: string[] = []
    const asked: string[] = []
    const params = { message: 'Which API token?', requestedSchema: { type: 'object', properties: { token: { type: 'string' } } } }
    const server = acceptingServer('thread-typed', { ask: { method: 'mcpServer/elicitation/request', params } })
    const bridge = new CodexBridge(host(root, () => server, {
      agent: () => ({}) as never,
      approve: async (_agent, toolName) => { asked.push(toolName); return 'allowed-once' },
      session: () => ({ snapshotEvents: () => [], append: (_type: string, message: { content: Array<{ text?: string }> }) => { notices.push(message.content.map(block => block.text ?? '').join('')) } } as never),
    }))
    const end = await bridge.run({ sessionId: 'typed', cwd: '/work', text: 'go', signal: new AbortController().signal, onChunk: () => {} })
    expect(end).toEqual({ status: 'completed' })
    expect(asked).toEqual([])
    expect(await server.answered).toEqual({ action: 'decline' })
    expect(notices.join('\n')).toContain('无法代填 Codex 要求的文本回答')
    await bridge.close()
  })

  it('isolates sessions and records a lost thread', async () => {
    const root = await mkdtemp(join(tmpdir(), 'codex-session-'))
    await writeRecord(root, { version: 1, sessionId: 'lost', status: 'idle', activities: [], threadId: 'gone' })
    const notices: string[] = []
    const bridge = new CodexBridge(host(root, () => acceptingServer('thread-b', { failResume: true }), { session: () => ({ append: (_type: string, message: { content: Array<{ text?: string }> }) => { notices.push(message.content.map(block => block.text ?? '').join('')) } } as never) }))
    await bridge.run({ sessionId: 'lost', cwd: '/work', text: 'again', signal: new AbortController().signal, onChunk: () => {} })
    expect((await readRecord(root, 'lost'))?.threadId).toBe('thread-b')
    expect(notices.join('\n')).toContain('先前线程不可用')
    const other = new CodexBridge(host(root, () => acceptingServer('thread-c')))
    await other.run({ sessionId: 'beta', cwd: '/work', text: 'other', signal: new AbortController().signal, onChunk: () => {} })
    expect((await readRecord(root, 'beta'))?.threadId).toBe('thread-c')
    expect((await readRecord(root, 'lost'))?.threadId).toBe('thread-b')
    await bridge.close()
    await other.close()
  })

  it('serializes turns in one session and fails closed when the journal cannot be stored', async () => {
    const root = await mkdtemp(join(tmpdir(), 'codex-session-'))
    const bridge = new CodexBridge(host(root, () => acceptingServer('thread-d')))
    const order: string[] = []
    const signal = new AbortController().signal
    await Promise.all([
      bridge.run({ sessionId: 'same', cwd: '/work', text: 'a', signal, onChunk: chunk => { if (chunk.type === 'finish') order.push('a') } }),
      bridge.run({ sessionId: 'same', cwd: '/work', text: 'b', signal, onChunk: chunk => { if (chunk.type === 'finish') order.push('b') } }),
    ])
    expect(order).toEqual(['a', 'b'])
    await bridge.close()
    const denied = new CodexBridge(host('/not-a-directory/definitely/missing-file', () => acceptingServer('thread-e')))
    const end = await denied.run({ sessionId: '../escape', cwd: '/work', text: 'no', signal, onChunk: () => {} })
    expect(end.status).toBe('failed')
    await denied.close()
  })

  it('answers title and compaction locally and sends only the latest human text', async () => {
    const root = await mkdtemp(join(tmpdir(), 'codex-session-'))
    let seen = ''
    const bridge = new CodexBridge(host(root, () => acceptingServer('thread-f')))
    const original = bridge.run.bind(bridge)
    bridge.run = async request => { seen = request.text; return await original(request) }
    const adapter = new CodexAdapter(bridge, () => '/work')
    const title = []
    for await (const chunk of adapter.stream({ purpose: 'session-title', messages: [], model: 'native', provider: 'codex' } as never)) title.push(chunk)
    expect(title.some(chunk => chunk.type === 'text-delta' && chunk.text === '【codex】新会话')).toBe(true)
    expect(seen).toBe('')
    const framed = [{
      role: 'user',
      source: { kind: 'plugin', plugin: 'dsh-session-title-llm' },
      content: [{ type: 'text', text: 'Generate the session title from this JSON array of human messages:\n' + JSON.stringify([{ seq: 3, text: '帮我修一下登录跳转' }]) }],
    }]
    const framedTitle = []
    for await (const chunk of adapter.stream({ purpose: 'session-title', messages: framed, model: 'native', provider: 'codex' } as never)) framedTitle.push(chunk)
    expect(framedTitle.some(chunk => chunk.type === 'text-delta' && chunk.text === '【codex】帮我修一下登录跳转')).toBe(true)
    const messages = [
      { role: 'user', source: { kind: 'plugin', plugin: 'codex-controller', form: 'notice' }, content: [{ type: 'text', text: 'notice' }] },
      { role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: '请用 /review 看这个改动' }] },
      { role: 'user', source: { kind: 'skill-invocation', form: 'instructions' }, content: [{ type: 'text', text: 'skill body' }] },
      { role: 'user', source: { kind: 'plugin', plugin: 'tool-cordis', form: 'instructions' }, content: [{ type: 'text', text: 'plugin reference' }] },
    ]
    expect(turnText(messages as never)).toBe('请用 /review 看这个改动\n\nskill body\n\nplugin reference')
    expect(localTitle('请用 /review 看这个改动')).toBe('【codex】请用 /review 看这个改动')
    expect(threadIdFromSession({ snapshotEvents: () => [{ type: 'user/message', data: { source: { kind: 'plugin', plugin: 'codex-controller' }, content: [{ type: 'text', text: 'codex-thread:abc' }] } }] } as never)).toBe('abc')
    await bridge.close()
  })

  it('makes delegation create a visible session and wait for its turn', async () => {
    const root = await mkdtemp(join(tmpdir(), 'codex-session-'))
    const bridge = new CodexBridge(host(root, () => acceptingServer('thread-g')))
    let tool: { execute: (args: { task: string }, exec: { signal: AbortSignal; agent?: { session: { header: { cwd: string } } } }) => Promise<{ result: string }> } | undefined
    const ctx = { tools: { register: (value: typeof tool) => { tool = value } }, sessionController: {
      async create() { return { sessionId: 'delegated' } },
      async selectModel() {},
      async rename() {},
      async prompt() { await bridge.run({ sessionId: 'delegated', cwd: '/work', text: 'task', signal: new AbortController().signal, onChunk: () => {} }) },
    } }
    registerDelegate(ctx as never, bridge, () => 'http://127.0.0.1:1', () => ctx.sessionController as never)
    const result = await tool!.execute({ task: 'do the thing' }, { signal: new AbortController().signal, agent: { session: { header: { cwd: '/work' } } } })
    expect(result.result).toContain('delegated')
    expect(result.result).toContain('http://127.0.0.1:1/#session=delegated')
    expect((await readRecord(root, 'delegated'))?.threadId).toBe('thread-g')
    await bridge.close()
  })
})
