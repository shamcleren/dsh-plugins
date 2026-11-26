import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { TestResources } from './resources.js'

it('joins interrupted fixture setup and its child before directory cleanup', async ({ signal }) => {
  const dir = await mkdtemp(join(tmpdir(), 'github-test-lifetime-')), workdir = join(dir, 'fixture'), marker = join(dir, 'reaped')
  const abort = new AbortController(), resources = new TestResources(AbortSignal.any([signal, abort.signal]))
  let setupFinished = false, cleanupJoined = false, ready!: () => void
  const entered = new Promise<void>(resolve => { ready = resolve })
  try {
    await mkdir(workdir)
    resources.defer(async () => {
      cleanupJoined = setupFinished && await readFile(marker, 'utf8') === 'closed'
      await rm(workdir, { recursive: true })
    })
    const setup = resources.run(async () => {
      try {
        const code = `const fs=require('node:fs');process.on('SIGTERM',()=>{fs.writeFileSync(${JSON.stringify(marker)},'closed');process.exit()});console.log('ready');setInterval(()=>{},1000)`
        await resources.execute(process.execPath, ['-e', code], { cwd: workdir, onOutput: text => { if (text.includes('ready')) ready() } })
      } finally { setupFinished = true }
    })
    const rejected = expect(setup).rejects.toMatchObject({ code: 'stopped' })
    await entered
    abort.abort()
    await resources.close()
    await rejected
    expect(cleanupJoined).toBe(true)
  } finally { await resources.close(); await rm(dir, { recursive: true, force: true }) }
})

it('refuses queued work after cancellation and runs all disposers even if one fails', async ({ signal }) => {
  const resources = new TestResources(signal), work = vi.fn(async () => undefined), order: string[] = []
  resources.defer(async () => { order.push('directory') })
  resources.defer(async () => { order.push('service'); throw new Error('fixture cleanup failure') })
  const queued = resources.run(work)
  const rejected = expect(queued).rejects.toMatchObject({ code: 'stopped' })
  await expect(resources.close()).rejects.toThrow('Fixture cleanup failed')
  await rejected
  expect(work).not.toHaveBeenCalled()
  expect(order).toEqual(['service', 'directory'])
  await expect(resources.run(work)).rejects.toMatchObject({ code: 'stopped' })
})
