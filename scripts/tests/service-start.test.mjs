import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { createServer } from 'node:http'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { quote } from '../dhp-command.mjs'
import { controlService } from '../service.mjs'

for (const occupied of [false, true]) test('real Web startup ' + (occupied ? 'rejects a port conflict without contacting or stopping its owner' : 'waits for the official Host to become ready'), { timeout: 45000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'dhp-service-start-')), home = join(root, 'home')
  t.after(() => rm(root, { recursive: true, force: true }))
  let requests = 0
  const portOwner = createServer((_request, response) => { requests++; response.end('other service') })
  await new Promise(resolve => portOwner.listen(0, '127.0.0.1', resolve))
  const port = portOwner.address().port
  if (!occupied) await new Promise(resolve => portOwner.close(resolve))
  else t.after(() => new Promise(resolve => portOwner.close(resolve)))
  await mkdir(join(root, 'bin')); await mkdir(join(root, 'DeepSeek Harness.app'))
  await mkdir(join(home, 'profiles/web'), { recursive: true })
  await writeFile(join(home, 'profiles/web/package.json'), JSON.stringify({ private: true, dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'] } } }))
  await writeFile(join(root, 'bootstrap-state.json'), JSON.stringify({ owner: 'shamcleren/dsh-plugin/bootstrap-v1', schemaVersion: 2, status: 'ready', dshHome: home, desktop: true }))
  await writeFile(join(root, 'native-app.json'), JSON.stringify({ app: 'DeepSeek Harness.app', servicePort: port, version: '0.2.16' }))
  const cli = fileURLToPath(new URL('../../runtime/node_modules/@deepseek-ai/dsh/lib/bin.js', import.meta.url))
  await writeFile(join(root, 'bin/dsh'), '#!/bin/sh\nexec ' + quote(process.execPath) + ' ' + quote(cli) + ' "$@"\n', { mode: 0o700 })
  let child, closed
  const lines = []
  try {
    const operation = controlService({ action: 'start', web: true, directory: root, log: line => lines.push(line), inspect: async () => ({ stdout: '' }),
      spawnProcess(command, args, options) {
        child = spawn(command, args, { ...options, env: { PATH: process.env.PATH, HOME: home, DSH_HOME: home } })
        closed = once(child, 'close')
        return child
      },
    })
    if (occupied) {
      await assert.rejects(operation, /failed before becoming ready/)
      assert.ok(!lines.some(line => line.startsWith('Started web')))
      assert.equal(requests, 0)
      assert.ok(portOwner.listening)
    } else {
      await operation
      assert.ok(lines.some(line => line.startsWith('Started web')))
      assert.equal(child.exitCode, null)
    }
  } finally {
    if (child?.exitCode == null && child?.signalCode == null) child?.kill('SIGTERM')
    if (closed) await closed
  }
})
