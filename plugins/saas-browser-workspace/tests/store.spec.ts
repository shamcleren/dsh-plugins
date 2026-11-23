import { mkdtemp, rm, readFile, rename } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { RunStore } from '../src/store.js'
import type { Run } from '../src/contract.js'

const owned: { store: RunStore; dir: string }[] = []
afterEach(async () => { const fixtures = owned.splice(0); await Promise.all(fixtures.map(({ store }) => store.close())); await Promise.all([...new Set(fixtures.map(({ dir }) => dir))].map(dir => rm(dir, { recursive: true, force: true }))) })
async function fixture() { const dir = await mkdtemp(join(tmpdir(), 'saas-store-')); const store = await RunStore.open(dir); owned.push({ store, dir }); return { store, dir } }
const bound = (run: Run) => ({ sessionId: run.sessionId, runId: run.id, revision: run.revision })
const request = (run: Run) => ({ ...bound(run), inputId: run.input.id, fields: { keyword: '初始化', view: 'table' as const } })
it('only hands off the current pending login and preserves its query for continuation', async () => {
  const { store } = await fixture(), run = await store.create('session-a', 'Fixture', { keyword: '初始化', view: 'table' })
  let shown = 0
  const show = async () => { shown++ }
  await expect(store.showLogin(bound(run), show)).rejects.toThrow('stale-input')
  await store.start(run.sessionId, run.id)
  const login = await store.finish(run.sessionId, run.id, 'awaiting_login')
  await expect(store.showLogin({ ...bound(login), sessionId: 'session-b' }, show)).rejects.toThrow('not-found')
  await expect(store.showLogin(bound(run), show)).rejects.toThrow('stale-input')
  expect(await store.showLogin(bound(login), show)).toEqual(login)
  expect(shown).toBe(1)
  const resumed = await store.resume(bound(login), async () => {})
  expect(resumed.id).toBe(run.id); expect(resumed.input.fields.keyword).toBe('初始化')
  await expect(store.showLogin(bound(resumed), show)).rejects.toThrow('stale-input')
  expect(shown).toBe(1)
})
it('serializes duplicate form submits into one native session request', async () => {
  const { store } = await fixture(), run = await store.create('session-a', 'Fixture')
  const calls: string[][] = [], enqueue = async (...args: string[]) => { calls.push(args) }
  const results = await Promise.all([store.submit(request(run), enqueue), store.submit(request(run), enqueue)])
  expect(calls).toHaveLength(1); expect(calls[0]?.[0]).toBe('session-a'); expect(calls[0]?.[2]).toBe(run.id)
  expect(results[0]).toEqual(results[1]); expect(results[0]?.input.accepted).toBe(true)
})
it('persists the request identity before admission and reuses it after a lost receipt', async () => {
  const { store, dir } = await fixture(), run = await store.create('session-a', 'Fixture')
  const calls: string[] = []
  await expect(store.submit(request(run), async (_session, id) => { calls.push(id); expect(JSON.parse(await readFile(join(dir, 'runs.json'), 'utf8'))[0].input.requestId).toBe(id); throw new Error('receipt lost') })).rejects.toThrow('receipt lost')
  await store.submit(request(run), async (_session, id) => { calls.push(id) })
  expect(calls).toHaveLength(2); expect(new Set(calls).size).toBe(1)
})
it('rejects stale fields, cross-session requests and concurrent browser jobs', async () => {
  const { store } = await fixture(), run = await store.create('session-a', 'Fixture')
  await expect(store.submit({ ...request(run), sessionId: 'session-b' }, async () => {})).rejects.toThrow('not-found')
  await expect(store.create('session-b', 'Fixture')).rejects.toThrow('task-busy')
  await store.submit(request(run), async () => {})
  await expect(store.submit({ ...request(run), fields: { keyword: 'other', view: 'table' } }, async () => {})).rejects.toThrow('stale-input')
})
it('never admits an input whose request identity failed to persist', async () => {
  const { store, dir } = await fixture(), run = await store.create('session-a', 'Fixture')
  let calls = 0
  await rename(dir, dir + '-offline')
  try { await expect(store.submit(request(run), async () => { calls++ })).rejects.toThrow() }
  finally { await rename(dir + '-offline', dir) }
  expect(calls).toBe(0); expect(store.get(run.sessionId, run.id)).toEqual(run)
  await store.submit(request(run), async (_session, id) => {
    calls++; expect(JSON.parse(await readFile(join(dir, 'runs.json'), 'utf8'))[0].input.requestId).toBe(id)
  })
  expect(calls).toBe(1)
})
it('does not replay browser work on restart or overwrite cancellation with late completion', async () => {
  const { store, dir } = await fixture(), run = await store.create('session-a', 'Fixture', { keyword: 'x', view: 'table' })
  const running = await store.start(run.sessionId, run.id)
  const cancelled = await store.cancel(bound(running))
  expect((await store.finish(run.sessionId, run.id, 'failed')).status).toBe('cancelled')
  const edited = await store.edit(bound(cancelled)); await store.close()
  const reopened = await RunStore.open(dir); owned.push({ store: reopened, dir })
  expect(reopened.get(edited.sessionId, edited.id).status).toBe('interrupted')
  await expect(reopened.start(edited.sessionId, edited.id)).rejects.toThrow('stale-input')
})
