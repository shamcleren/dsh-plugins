import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import test from 'node:test'

const run = promisify(execFile)
const root = new URL('../', import.meta.url)

test('real WebKit navigation keeps external links out of the Host window', { skip: process.platform !== 'darwin', timeout: 120_000 }, async t => {
  const scratch = await mkdtemp(join(tmpdir(), 'dsh-native-navigation-'))
  t.after(() => rm(scratch, { recursive: true, force: true }))
  const server = createServer((request, response) => {
    if (request.url === '/redirect') {
      response.writeHead(302, { location: `http://localhost:${server.address().port}/foreign` })
      response.end()
    } else if (request.url === '/download') {
      response.writeHead(200, { 'content-type': 'application/octet-stream' })
      response.end('report')
    } else {
      response.writeHead(200, { 'content-type': 'text/html' })
      response.end(`<html><body id="${request.url === '/foreign' ? 'foreign' : 'dsh-fixture'}">DSH navigation fixture</body></html>`)
    }
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise((resolve, reject) => {
    server.close(error => error ? reject(error) : resolve())
    server.closeAllConnections()
  }))
  const binary = join(scratch, 'navigation')
  await run('/usr/bin/xcrun', ['swiftc', '-parse-as-library', '-framework', 'AppKit', '-framework', 'WebKit',
    ...['Sources/MainWindowController.swift', 'Sources/WebDownloads.swift', 'Sources/ShareBridge.swift', 'Share/ShareInbox.swift', 'tests/navigation/main.swift']
      .map(name => fileURLToPath(new URL(name, root))), '-o', binary])
  const { stdout } = await run(binary, [`http://127.0.0.1:${server.address().port}/`], { timeout: 90_000 })
  assert.equal(stdout.trim(), 'External links preserve the Host window; internal navigation and downloads remain available')
})
