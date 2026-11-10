import assert from 'node:assert/strict'
import test from 'node:test'
import { runDhp } from '../dhp.mjs'
import { readModes } from '../modes.mjs'

test('workbench compositions reference only published catalog plugins and can be listed without an installation', async () => {
  const modes = await readModes()
  assert.deepEqual(modes.map(mode => mode.id), ['remote-development', 'research-briefing'])
  const lines = []
  assert.equal(await runDhp(['mode', 'list'], { log: line => lines.push(line) }), 0)
  assert.match(lines.join('\n'), /远程开发工作台/)
  assert.match(lines.join('\n'), /资料简报工作台/)
})

test('mode plans describe preparation and never initialize the requested directory', async () => {
  const lines = []
  assert.equal(await runDhp(['--dir', '/nonexistent/dhp-mode-fixture', 'mode', 'plan', 'research-briefing'], { log: line => lines.push(line) }), 0)
  assert.match(lines.join('\n'), /dhp plugin install web-search/)
  assert.match(lines.join('\n'), /Plan only/)
  await assert.rejects(runDhp(['mode', 'plan', 'unknown'], { log() {} }), /Unknown workbench mode/)
})
