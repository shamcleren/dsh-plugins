import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { GitHub } from '../src/github.js'
import { commandEnvironment, execute, type Execute } from '../src/process.js'
import { allowedPath, changesFromPorcelain } from '../src/git.js'
import { zh, en } from '../src/client/locales.js'
import { Tasks } from '../src/tasks.js'

it('cancels queued work before its callback can start', async () => {
  const tasks = new Tasks()
  let entered = false
  const task = tasks.start('demo/repository', 'open', async () => { entered = true })
  tasks.cancel(task.id)
  await tasks.stop()
  expect(entered).toBe(false)
  expect(tasks.list()[0]?.status).toBe('cancelled')
})

it('aborts and reaps an owned command before reporting shutdown', async () => {
  const scratch = await mkdtemp(join(tmpdir(), 'github-command-stop-')), marker = join(scratch, 'closed')
  const abort = new AbortController()
  try {
    const code = `const fs=require('node:fs');process.on('SIGTERM',()=>{fs.writeFileSync(${JSON.stringify(marker)},'closed');process.exit()});console.log('ready');setInterval(()=>{},1000)`
    await expect(execute(process.execPath, ['-e', code], { signal: abort.signal, onOutput: text => { if (text.includes('ready')) abort.abort() } })).rejects.toMatchObject({ code: 'stopped' })
    expect(await readFile(marker, 'utf8')).toBe('closed')
  } finally { await rm(scratch, { recursive: true, force: true }) }
})

it('exposes only the device code and cancels the owned login without returning raw CLI output', async () => {
  let signal: AbortSignal | undefined
  const run: Execute = async (_command, _args, options) => {
    options?.onOutput?.('First copy your one-time code: ABCD-1234\nprivate fixture token: never-display\n')
    signal = options?.signal
    await new Promise<void>(resolve => signal?.addEventListener('abort', () => resolve(), { once: true }))
    return { code: 1, stdout: '', stderr: 'never-display' }
  }
  const github = new GitHub(run, () => ({ env: commandEnvironment() }))
  github.beginLogin()
  expect(github.login).toEqual({ status: 'pending', code: 'ABCD-1234' })
  await github.cancelLogin()
  expect(signal?.aborted).toBe(true)
  expect(github.login).toEqual({ status: 'failed' })
  expect(JSON.stringify(github.login)).not.toContain('never-display')
})

it('parses NUL-separated renames and keeps locale dictionaries complete', () => {
  expect(changesFromPorcelain('R  new name\0old name\0?? .env\0')).toEqual([
    { path: 'new name', paths: ['new name', 'old name'], status: 'R ', blocked: false },
    { path: '.env', paths: ['.env'], status: '??', blocked: true },
  ])
  expect(allowedPath('.env.example')).toBe(true)
  expect(allowedPath('nested/private.pem')).toBe(false)
  expect(Object.keys(zh).sort()).toEqual(Object.keys(en).sort())
})
