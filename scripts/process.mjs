/** Run one owned process group and wait for teardown when interrupted. */
import { spawn } from 'node:child_process'

export function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { ...options, stdio: options.stdio ?? 'inherit', detached: process.platform !== 'win32' })
    let interrupted
    let timer
    const signalGroup = signal => {
      if (child.pid === undefined) return
      try {
        if (process.platform === 'win32') child.kill(signal)
        else process.kill(-child.pid, signal)
      } catch (error) { if (error.code !== 'ESRCH') throw error }
    }
    const stop = signal => {
      interrupted = signal
      signalGroup(signal)
      timer ??= setTimeout(() => signalGroup('SIGKILL'), 5000)
    }
    const onInt = () => stop('SIGINT')
    const onTerm = () => stop('SIGTERM')
    process.on('SIGINT', onInt); process.on('SIGTERM', onTerm)
    const cleanup = () => {
      clearTimeout(timer)
      process.off('SIGINT', onInt); process.off('SIGTERM', onTerm)
    }
    child.once('error', error => { cleanup(); reject(error) })
    child.once('close', (code, signal) => {
      if (interrupted) signalGroup('SIGKILL')
      cleanup()
      if (code === 0 && !signal && !interrupted) resolve()
      else {
        const error = new Error(command + ' failed (' + (interrupted ?? signal ?? code) + ')')
        if (!interrupted && !signal && Number.isInteger(code)) error.exitCode = code
        reject(error)
      }
    })
  })
}
