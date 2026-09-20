import { beforeEach, expect, it, vi } from 'vitest'

const runScanner = vi.hoisted(() => vi.fn())
vi.mock('../src/process.js', () => ({ runScanner }))

import { git } from '../src/repository.js'

beforeEach(() => { runScanner.mockReset(); runScanner.mockResolvedValue({ code: 0, stdout: '' }) })

it('keeps system credential helpers while preserving non-interactive Git isolation', async () => {
  await git('/tmp', ['status'], new AbortController().signal)

  const [binary, args, , , environment] = runScanner.mock.calls[0]!
  expect(binary).toBe('/usr/bin/git')
  expect(environment).toMatchObject({ GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0' })
  expect(environment).not.toHaveProperty('GIT_CONFIG_NOSYSTEM')
  expect(args).toEqual(expect.arrayContaining([
    '-c', 'core.hooksPath=/dev/null',
    'protocol.ext.allow=never',
    'protocol.file.allow=never',
    'diff.external=',
  ]))
})
