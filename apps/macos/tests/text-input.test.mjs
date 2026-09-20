import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import test from 'node:test'

const run = promisify(execFile)
const root = new URL('../', import.meta.url)

test('real WebKit disables native writing suggestions and corrections for text editors', { skip: process.platform !== 'darwin', timeout: 120_000 }, async t => {
  const scratch = await mkdtemp(join(tmpdir(), 'dsh-native-text-input-'))
  t.after(() => rm(scratch, { recursive: true, force: true }))
  const binary = join(scratch, 'text-input')
  await run('/usr/bin/xcrun', ['swiftc', '-parse-as-library', '-framework', 'AppKit', '-framework', 'WebKit',
    ...['Sources/MainWindowController.swift', 'Sources/WebDownloads.swift', 'Sources/ShareBridge.swift', 'Share/ShareInbox.swift', 'tests/text-input/main.swift']
      .map(name => fileURLToPath(new URL(name, root))), '-o', binary])
  const { stdout } = await run(binary, { timeout: 90_000 })
  assert.equal(stdout.trim(), 'Native writing suggestions and text corrections are disabled')
})
