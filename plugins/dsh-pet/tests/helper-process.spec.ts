import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { HelperProcess } from '../src/helper-process.js'
import type { CompanionMessage } from '../src/protocol.js'

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

describe('HelperProcess', () => {
  it('waits for the final move and closed messages during graceful shutdown', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'desktop-pet-helper-'))
    temporaryDirectories.push(dir)
    const fixture = join(dir, 'helper-fixture')
    await writeFile(fixture, `#!/bin/sh
IFS= read -r request
printf '%s\\n' '{"protocolVersion":1,"kind":"move","position":{"x":321,"y":654},"positionMode":"pet-anchor"}'
printf '%s\\n' '{"protocolVersion":1,"kind":"closed"}'
`, 'utf8')
    await chmod(fixture, 0o755)

    const messages: CompanionMessage[] = []
    const errors: Error[] = []
    const helper = new HelperProcess({
      binaryPath: fixture,
      onMessage: message => messages.push(message),
      onError: error => errors.push(error),
      onExit: () => undefined,
      onStderr: () => undefined,
    })

    helper.start()
    const stopping = helper.stop()
    expect(helper.stop()).toBe(stopping)
    await stopping

    expect(errors).toEqual([])
    expect(messages.map(message => message.kind)).toEqual(['move', 'closed'])
    expect(messages[0]).toMatchObject({
      position: { x: 321, y: 654 },
      positionMode: 'pet-anchor',
    })
    expect(helper.running).toBe(false)
  })
})
