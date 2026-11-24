import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'
import { startFixture } from './fixture.mjs'

if (!process.env.DSH_SAAS_MODEL_CONFIG) throw new Error('Set DSH_SAAS_MODEL_CONFIG to an authorized real model route; this test does not simulate model decisions.')
const scratch = await mkdtemp(join(tmpdir(), 'saas-agent-smoke-')), infoFile = join(scratch, 'info.json')
const fixture = await startFixture({ indirectConfig: true, execution: true, approvals: true }), siteFile = join(scratch, 'site.json')
await writeFile(siteFile, JSON.stringify(fixture.site), { mode: 0o600 })
const demo = spawn(process.execPath, [join(dirname(fileURLToPath(import.meta.url)), 'demo.mjs')], {
  env: { ...process.env, DSH_DEMO_INFO: infoFile, DSH_SAAS_SITE_CONFIG: siteFile,
    DSH_SAAS_PROMPT: '我要查询智能体并选择一个查看配置。请先用业务表单向我询问缺少的关键词，收到后查询并用表格展示，等待我选择。' }, stdio: ['ignore', 'pipe', 'pipe'],
})
let output = ''; for (const stream of [demo.stdout, demo.stderr]) stream.on('data', bytes => { output += bytes })
const exited = once(demo, 'exit')
async function wait(check, label, timeout = 120_000) {
  const until = Date.now() + timeout
  while (Date.now() < until) {
    if (demo.exitCode !== null) throw new Error('Demo exited: ' + output)
    const result = await check(); if (result) return result
    await new Promise(resolve => setTimeout(resolve, 150))
  }
  throw new Error('Timed out: ' + label + '\n' + output)
}
try {
  const info = await wait(async () => { try { return JSON.parse(await readFile(infoFile, 'utf8')) } catch (e) { if (e.code !== 'ENOENT') throw e } }, 'packed native profile')
  const origin = new URL(info.url).origin
  assert.equal(new URL(origin).hostname, '127.0.0.1')
  const login = await fetch(info.url, { redirect: 'manual' })
  const cookie = login.headers.getSetCookie().map(value => value.split(';')[0]).join('; ')
  async function rpc(method, payload) {
    const response = await fetch(origin + '/saas-agent/' + method, { method: 'POST', headers: { 'content-type': 'application/json', cookie }, body: JSON.stringify({ type: 'client-request', rpcId: randomUUID(), method, payload }) })
    assert.equal(response.status, 200)
    return (await response.json()).result
  }
  const state = async () => { const result = await rpc('state', { sessionId: info.sessionId }); assert.equal(result.ok, true); return result.value }
  const events = async () => JSON.parse(await readFile(join(info.scratch, 'ready.json.events.json'), 'utf8'))
  const idle = async () => {
    let journal
    try { journal = await events() } catch (error) { if (error.code === 'ENOENT') return false; throw error }
    const end = journal.findLastIndex(e => e.type === 'turn/end'), start = journal.findLastIndex(e => e.type === 'turn/start')
    if (end > start && journal[end].data.reason.kind === 'error') {
      const code = journal[end].data.reason.error.code
      if (code === 'AUTH') assert.equal((await state()).error, 'model-auth-required')
      console.log('Verified: official profile activated; model failure surfaced in the SaaS workspace. End-to-end flow did not complete.')
      throw new Error('Real model failed (' + code + '). Inspect the private session log; no fallback model was used.')
    }
    if (end > start && (await state()).phase === 'failed') throw new Error('Workspace failed: ' + (await state()).error)
    return end > start
  }
  const question = await wait(async () => { const value = await state(); const done = await idle(); return done && value.phase === 'awaiting_input' && value.question }, 'real agent asks for missing keyword')
  assert.equal(question.fields.length, 1)
  assert.equal((await rpc('answer', { sessionId: info.sessionId, questionId: question.id, answers: { [question.fields[0].name]: '初始化' } })).ok, true)
  const results = await wait(async () => { const value = await state(); const done = await idle(); return done && value.phase === 'ready' && value.observation?.records.length === 3 && value }, 'real agent searches and presents results')
  const row = results.observation.records[0]
  assert.equal(row.actions.length, 0)
  assert.ok(row)
  assert.equal((await rpc('select', { sessionId: info.sessionId, observationId: results.observation.id, recordId: row.id })).ok, true)
  const details = await wait(async () => { const value = await state(); const done = await idle(); return done && value.view === 'details' && value.observation?.url.includes('/agents/config') && value }, 'real agent opens selected configuration')
  assert.ok(details.observation.controls.some(control => control.value === 'fixture-model'))
  assert.ok(details.observation.document.blocks.flatMap(block => block.kind === 'fields' ? block.fields : []).some(field => field.state === 'value' && field.value === 'fixture-model'))
  assert.ok(!JSON.stringify(details).includes('fixture-secret'))
  const frame = origin + '/api/saas-agent/frame?' + new URLSearchParams({ sessionId: info.sessionId })
  const image = await fetch(frame, { headers: { cookie } }); assert.equal(image.status, 200)
  assert.equal(Buffer.from(await image.arrayBuffer()).subarray(0, 2).toString('hex'), 'ffd8')
  assert.equal((await fetch(frame)).status, 401)
  assert.equal((await fetch(origin + '/api/saas-agent/frame?sessionId=unknown', { headers: { cookie } })).status, 404)
  const live = origin + '/api/saas-agent/live?' + new URLSearchParams({ sessionId: info.sessionId })
  assert.equal((await fetch(live)).status, 401)
  const viewing = new AbortController()
  try {
    const connected = await fetch(live, { headers: { cookie }, signal: AbortSignal.any([viewing.signal, AbortSignal.timeout(12_000)]) })
    assert.equal(connected.headers.get('content-type'), 'application/octet-stream')
    const reader = connected.body.getReader()
    let bytes = Buffer.alloc(0)
    while (true) {
      const next = await reader.read()
      assert.equal(next.done, false)
      bytes = Buffer.concat([bytes, next.value])
      while (bytes.length >= 16 && !bytes.readUInt32BE(0)) bytes = bytes.subarray(16)
      if (bytes.length < 18) continue
      assert.ok(bytes.readUInt32BE(0) > 2)
      assert.ok(bytes.readUInt32BE(12) > 0)
      assert.equal(bytes.subarray(16, 18).toString('hex'), 'ffd8')
      break
    }
  } finally { viewing.abort() }

  // Exercise the owner flow against a real browser and frozen proof on the official host.
  assert.equal((await rpc('takeover', { sessionId: info.sessionId })).ok, true)
  const reviewClick = () => rpc('input', { sessionId: info.sessionId, input: { kind: 'click', x: 180, y: 420 } })
  assert.equal((await reviewClick()).ok, true)
  const cancelled = (await state()).review
  assert.equal(cancelled.label, '知识库（1）')
  assert.equal((await rpc('cancelApproval', { sessionId: info.sessionId, approvalId: cancelled.id })).ok, true)
  assert.equal((await rpc('approve', { sessionId: info.sessionId, approvalId: cancelled.id })).ok, false)
  assert.equal((await rpc('takeover', { sessionId: info.sessionId })).ok, true)
  assert.equal((await reviewClick()).ok, true)
  const proposed = await state()
  assert.equal(proposed.phase, 'awaiting_approval')
  assert.equal(proposed.review.label, '知识库（1）')
  assert.ok(!proposed.observation.text.includes('Fixture retrieval handbook'))
  const reviewFrame = frame + '&approvalId=' + proposed.review.id
  const preview = await fetch(reviewFrame, { headers: { cookie } })
  assert.equal(preview.status, 200)
  assert.equal(Buffer.from(await preview.arrayBuffer()).subarray(0, 2).toString('hex'), 'ffd8')
  assert.equal((await fetch(reviewFrame)).status, 401)
  assert.equal((await rpc('approve', { sessionId: info.sessionId, approvalId: proposed.review.id })).ok, true)
  assert.equal((await rpc('approve', { sessionId: info.sessionId, approvalId: proposed.review.id })).ok, false)
  assert.equal((await fetch(reviewFrame, { headers: { cookie } })).status, 404)
  const expanded = await wait(async () => {
    const value = await state()
    return !value.agentRunning && value.phase === 'ready' && value.details?.text.includes('Fixture retrieval handbook') && value
  }, 'owner approves one custom disclosure and the agent resumes')
  assert.ok(expanded.details.document.blocks.flatMap(block => block.fields ?? []).some(field => field.label === '检索数量' && field.value === '5'))

  for (const mode of ['debug', 'use']) {
    assert.equal((await rpc('execute', { sessionId: info.sessionId, mode })).ok, true)
    let answered = false
    const executed = await wait(async () => {
      const value = await state(); const done = await idle()
      if (!done) return
      if (value.phase === 'awaiting_input') {
        assert.equal(answered, false, 'Agent repeated the same message form')
        assert.equal(value.question.fields.length, 1)
        assert.equal((await rpc('answer', { sessionId: info.sessionId, questionId: value.question.id, answers: { [value.question.fields[0].name]: '请计算 17+25，只回复结果。' } })).ok, true)
        answered = true; return
      }
      return value.executions.find(run => run.mode === mode && run.status === 'completed')
    }, 'real agent completes ' + mode)
    assert.equal(executed.output, '42')
    assert.equal(fixture.stats.messages.filter(message => message.mode === mode).length, 1)
  }
  assert.equal(fixture.stats.saves, 0)
  const finalState = await state()
  assert.equal(finalState.executions.length, 2); assert.equal(finalState.view, 'results')
  const journal = await events(), calls = journal.filter(event => event.type === 'tool/call').map(event => event.data.name)
  assert.ok(calls.includes('saas_ask')); assert.ok(calls.filter(name => name === 'saas_browser').length >= 4); assert.ok(calls.includes('saas_present'))
  assert.ok(journal.filter(event => event.type === 'turn/end').length >= 3)
  assert.ok(journal.some(event => event.type === 'request/context' && event.data.provider === info.provider && event.data.model === info.model))
  console.log('PASS packed official Web profile; real model; missing-parameter form; native queue continuation; query → selection → configuration → debug → use (one actual fixture POST per mode, no saves); authenticated Chromium stream and JPEG evidence; password redaction; cancel and single-use owner approval. Fixture data only.')
} finally {
  if (demo.exitCode === null) demo.kill('SIGTERM')
  await exited; await fixture.close()
}
