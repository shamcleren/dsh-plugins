import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { waitForWeb } from '../web-ready.mjs'

async function fixture(t, contents = '') {
  const root = await mkdtemp(join(tmpdir(), 'dhp-web-ready-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const logPath = join(root, 'launcher.log')
  await writeFile(logPath, contents)
  return { child: new EventEmitter(), logPath, offset: 0, port: 3080 }
}

test('readiness accepts only a fresh authenticated URL emitted by this child', async t => {
  const old = 'dsh web: http://127.0.0.1:3080/?token=old\n'
  const f = await fixture(t, old + 'dsh web: http://127.0.0.1:3080/?token=fresh\n')
  const urls = []
  await waitForWeb({ ...f, offset: Buffer.byteLength(old), request: async url => {
    urls.push(String(url))
    return new Response(null, { status: 302, headers: { location: '/' } })
  } })
  assert.deepEqual(urls, ['http://127.0.0.1:3080/?token=fresh'])
})

test('readiness rejects early exit and never requests an existing service', async t => {
  const f = await fixture(t, 'dsh web: http://127.0.0.1:3080/?token=old\n')
  f.child.exitCode = 1
  await assert.rejects(waitForWeb({ ...f, request: async () => { throw new Error('unexpected request') } }), /failed before becoming ready/)
  assert.equal(f.child.listenerCount('error'), 0)
})

test('readiness times out without leaking tokens or following external redirects', async t => {
  const f = await fixture(t, 'dsh web: http://127.0.0.1:3080/?token=private-fixture\n')
  await assert.rejects(waitForWeb({ ...f, timeoutMs: 1, request: async () => new Response(null, { status: 302, headers: { location: 'https://external.invalid/' } }) }),
    error => /timed out/.test(error.message) && !error.message.includes('private-fixture'))
})

test('readiness ignores URLs for other ports, hosts and malformed token queries', async t => {
  const f = await fixture(t, ['http://example.invalid:3080/?token=x', 'http://127.0.0.1:3081/?token=x', 'http://127.0.0.1:3080/?token=x&other=y'].map(url => 'dsh web: ' + url + '\n').join(''))
  await assert.rejects(waitForWeb({ ...f, timeoutMs: 1, request: async () => { assert.fail('unexpected request') } }), /timed out/)
})
