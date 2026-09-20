import { spawn } from 'node:child_process'
import { dirname } from 'node:path'

/** Own the scanner process, bounded output, deadline, and descendant cleanup. */
export async function runScanner(binary: string, args: string[], cwd: string, signal: AbortSignal, environment?: Record<string, string>, timeoutMs = 120_000): Promise<{ code: number; stdout: string }> {
  signal.throwIfAborted()
  return await new Promise((resolve, reject) => {
    const child = spawn(binary, args, { cwd, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'],
      env: environment ?? { PATH: dirname(binary) + ':/usr/bin:/bin', HOME: cwd, TMPDIR: cwd,
        SEMGREP_SEND_METRICS: 'off', SEMGREP_ENABLE_VERSION_CHECK: '0', PYTHONNOUSERSITE: '1',
        SEMGREP_SETTINGS_FILE: cwd + '/settings.yml', OTEL_SDK_DISABLED: 'true' } })
    let failure: Error | undefined, bytes = 0
    let force: ReturnType<typeof setTimeout> | undefined
    const output: Buffer[] = []
    const kill = (kind: NodeJS.Signals): void => {
      if (child.pid === undefined) return
      try { if (process.platform === 'win32') child.kill(kind); else process.kill(-child.pid, kind) } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ESRCH') child.kill(kind)
      }
    }
    const stop = (reason: string): void => {
      if (failure) return
      failure = new Error(reason)
      kill('SIGTERM')
      force = setTimeout(() => { kill('SIGKILL') }, 2000)
    }
    const abort = (): void => { stop('Security scan cancelled') }
    const deadline = setTimeout(() => { stop('Security process exceeded its time limit') }, timeoutMs)
    signal.addEventListener('abort', abort, { once: true })
    if (signal.aborted) abort()
    const collect = (chunk: Buffer, keep: boolean): void => {
      bytes += chunk.length
      if (bytes > 8 * 1024 * 1024) stop('Security scanner output exceeded its limit')
      else if (keep) output.push(chunk)
    }
    child.stdout.on('data', (chunk: Buffer) => { collect(chunk, true) })
    child.stderr.on('data', (chunk: Buffer) => { collect(chunk, false) })
    child.once('error', () => { failure = new Error('Security scanner could not start') })
    child.once('close', code => {
      if (failure) kill('SIGKILL')
      clearTimeout(deadline); clearTimeout(force); signal.removeEventListener('abort', abort)
      // Scanner diagnostics and source snippets may contain secrets; do not return raw stderr.
      if (failure) reject(failure)
      else resolve({ code: code ?? -1, stdout: Buffer.concat(output).toString('utf8') })
    })
  })
}
