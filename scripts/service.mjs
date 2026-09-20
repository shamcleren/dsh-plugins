/** Start, stop and inspect installer-owned DSH processes. */
import { spawn } from 'node:child_process'
import { constants } from 'node:fs'
import { access, mkdir, open } from 'node:fs/promises'
import { join } from 'node:path'
import { installationBusy, listOwnedProcesses, readInstallation, readNativeApp } from './installation.mjs'
import { run } from './process.mjs'

async function waitUntil(check, attempts, waitMs) {
  for (let attempt = 0; attempt < attempts; attempt++) {
    if (await check()) return true
    if (attempt + 1 < attempts) await waitMs(50)
  }
  return false
}

export async function controlService({
  action, web = false, directory, repo, log = console.log, execute = run,
  inspect, spawnProcess = spawn, kill = (pid, signal) => process.kill(pid, signal),
  waitMs = ms => new Promise(resolve => setTimeout(resolve, ms)),
}) {
  if (!['start', 'stop', 'restart', 'status'].includes(action)) throw new Error('Unknown service command')
  const installation = await readInstallation(directory, repo)
  const { root, dshHome, launcher, desktop } = installation
  const owned = () => listOwnedProcesses(root, inspect ? { inspect } : {})
  if (action === 'status') {
    const processes = await owned()
    const app = desktop ? await readNativeApp(root).catch(() => undefined) : undefined
    log('Installation: ' + root)
    log('DSH home: ' + dshHome)
    log('Mode: ' + (app ? 'app port ' + app.port : 'web'))
    log(processes.length ? processes.map(item => 'Running PID ' + item.pid).join('\n') : 'Stopped')
    return { installation, processes, app }
  }
  if (action === 'restart' && !web && desktop) {
    await installationBusy(root)
    const app = await readNativeApp(root)
    const processes = await owned()
    if (app && processes.some(item => item.command.includes('/Contents/MacOS/DeepSeekHarness'))) {
      const controller = join(app.path, 'Contents/MacOS/DeepSeekHarnessControl')
      let legacy = false
      try { await access(controller, constants.X_OK) } catch (error) {
        if (error.code !== 'ENOENT') throw error
        // Older shells used reopen for restart. Since 0.2.10, reopening only
        // restores the window, so missing control support must be explicit.
        legacy = /^0\.(?:[01]\.\d+|2\.[0-9])$/.test(app.version ?? '')
        if (!legacy) throw new Error('Update or rebuild the native App to enable Host restart without reopening the window')
      }
      // The App receives the request before the Host tears down this CLI.
      await execute(legacy ? 'open' : controller, legacy ? [app.path] : [], { cwd: root })
      log('Requested Host restart from the running app: ' + app.path)
      return
    }
  }
  if (action === 'stop' || action === 'restart') {
    const processes = await owned()
    if (!processes.length) log('DSH is not running for this installation.')
    else {
      for (const item of processes) {
        try { kill(item.pid, 'SIGTERM') } catch (error) { if (error.code !== 'ESRCH') throw error }
      }
      const idle = await waitUntil(async () => !(await owned()).length, 160, waitMs)
      if (!idle) {
        for (const item of await owned()) {
          try { kill(item.pid, 'SIGKILL') } catch (error) { if (error.code !== 'ESRCH') throw error }
        }
        if (!await waitUntil(async () => !(await owned()).length, 40, waitMs)) {
          throw new Error('Could not stop this installation\'s DSH process')
        }
      }
      log('Stopped this installation\'s DSH process.')
    }
    if (action === 'stop') return
  }
  await installationBusy(root)
  const running = await owned()
  if (running.length) throw new Error('This installation is already running (PID ' + running[0].pid + '). Use dhp stop or dhp restart.')
  const app = (!web && desktop) ? await readNativeApp(root) : undefined
  if (app) {
    await execute('open', [app.path], { cwd: root })
    log('Opened app: open \'' + app.path.replaceAll("'", "'\\''") + '\'')
    return
  }
  const port = (desktop ? await readNativeApp(root).catch(() => undefined) : undefined)?.port ?? 3080
  await mkdir(join(root, 'logs'), { recursive: true, mode: 0o700 })
  const logFile = await open(join(root, 'logs/launcher.log'), 'a', 0o600)
  try {
    const child = spawnProcess(launcher, ['web', '--host', '127.0.0.1', '--port', String(port), '--no-open'], {
      cwd: root, detached: true, stdio: ['ignore', logFile.fd, logFile.fd],
    })
    if (typeof child.unref === 'function') child.unref()
  } finally { await logFile.close() }
  log('Started web: ' + launcher + ' web --host 127.0.0.1 --port ' + port)
}
