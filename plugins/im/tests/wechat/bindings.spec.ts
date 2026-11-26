import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { ConversationBindings } from '../../src/adapters/wechat/bindings.js'

const key = 'a'.repeat(64), other = 'b'.repeat(64)
const dirs: string[] = []
afterEach(async () => { await Promise.all(dirs.splice(0).map(p => rm(p, { recursive: true, force: true }))) })
async function location() {
  const dir = await mkdtemp(join(tmpdir(), 'wechat-session-history-'))
  dirs.push(dir)
  return join(dir, 'bindings.json')
}

it('retains old v1 bindings and adds durable peer histories without changing their active session', async () => {
  const file = await location()
  await writeFile(file, JSON.stringify({ version: 1, bindings: { [key]: 'session-wechat-original' } }))
  const store = await ConversationBindings.open(file)
  expect(store.list(key, 'session-wechat-fallback')).toEqual(['session-wechat-original'])
  await store.set(key, 'session-wechat-new')
  await store.set(key, 'session-wechat-original')
  const restored = await ConversationBindings.open(file)
  expect(restored.current(key, 'unused')).toBe('session-wechat-original')
  expect(restored.list(key, 'unused')).toEqual(['session-wechat-original', 'session-wechat-new'])
  expect((await stat(file)).mode & 0o777).toBe(0o600)
})

it('serializes concurrent peer writes and preserves selection order across switches', async () => {
  const file = await location(), store = await ConversationBindings.open(file)
  await Promise.all([
    store.set(key, 'session-wechat-two', 'session-wechat-one'),
    store.set(other, 'session-wechat-private'),
    store.set(key, 'session-wechat-three'),
  ])
  await store.set(key, 'session-wechat-one')
  const restored = await ConversationBindings.open(file)
  expect(restored.list(key, 'unused')).toEqual(['session-wechat-one', 'session-wechat-two', 'session-wechat-three'])
  expect(restored.list(other, 'unused')).toEqual(['session-wechat-private'])
  expect(restored.current(key, 'unused')).toBe('session-wechat-one')
})

it('retains the committed binding and history when persistence fails', async () => {
  const file = await location(), store = await ConversationBindings.open(file)
  await store.set(key, 'session-wechat-original')
  const parent = join(file, '..')
  await rm(parent, { recursive: true })
  await writeFile(parent, 'fixture path obstruction')
  await expect(store.set(key, 'session-wechat-new')).rejects.toThrow()
  expect(store.current(key, 'unused')).toBe('session-wechat-original')
  expect(store.list(key, 'unused')).toEqual(['session-wechat-original'])
})

it.each([
  { [key]: ['session-wechat-one', 'session-wechat-one'] },
  { [key]: ['session-foreign'] },
  { 'raw-user-id': ['session-wechat-one'] },
  { [key]: 'session-wechat-one' },
])('rejects malformed persisted history rather than losing it: %j', async histories => {
  const file = await location()
  const text = JSON.stringify({ version: 1, bindings: {}, histories })
  await writeFile(file, text)
  await expect(ConversationBindings.open(file)).rejects.toThrow('invalid history')
  expect(await readFile(file, 'utf8')).toBe(text)
})
