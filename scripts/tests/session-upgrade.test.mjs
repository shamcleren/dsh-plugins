/** Fixture written by unmodified DSH 0.1.6-alpha.2 using Session and JSONL persistence. */
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { copyFile, mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import test from 'node:test'

const require = createRequire(new URL('../../runtime/package.json', import.meta.url))
const load = name => import(pathToFileURL(require.resolve(name)).href)
test('official V3 to V4 migration preserves plugin notices and leaves the old generation intact', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-session-upgrade-'))
  const original = await readFile(new URL('../fixtures/session-v3-plugin-notices.jsonl', import.meta.url))
  const folder = join(root, '_no-cwd/upgrade-fixture')
  await mkdir(folder, { recursive: true })
  const old = join(folder, 'session.v3.jsonl')
  await copyFile(fileURLToPath(new URL('../fixtures/session-v3-plugin-notices.jsonl', import.meta.url)), old)
  const { Context } = await load('@deepseek-ai/cordis')
  const { default: Backend } = await load('@deepseek-ai/dsh-session-persistence-jsonl')
  const ctx = new Context()
  try {
    const fiber = await ctx.plugin(Backend, { root, compression: 'none' })
    for (const access of ['read', 'write', 'read']) {
      const handle = await fiber.ctx.sessionPersistence.open('upgrade-fixture', access)
      try {
        const { events } = await handle.read()
        assert.equal(handle.header.version, 4)
        assert.equal(events.length, 2)
        assert.equal(events[0].data.source.kind, 'plugin:codex-controller')
        assert.equal(events[0].data.content[0].text, 'codex-thread:fixture-123')
        assert.equal(events[1].data.source.kind, 'plugin:security-scan')
        assert.equal(events[1].data.source.summary, '旧报告')
        if (access === 'write') await handle.flush()
      } finally { await handle.close() }
      assert.deepEqual(await readFile(old), original)
    }
  } finally { await ctx.fiber.dispose(); await rm(root, { recursive: true, force: true }) }
})
