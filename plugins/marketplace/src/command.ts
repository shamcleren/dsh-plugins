/** Contained subprocess execution for the Marketplace installer. */

import { spawn } from 'node:child_process'

/** Result bytes and diagnostics from one bounded child command. */
export interface CommandResult {
  readonly stdout: Buffer
  readonly stderr: string
}

/**
 * Run one non-interactive command with bounded output and no inherited stdin.
 * @param executable Absolute path or command name to spawn.
 * @param args Command arguments passed without shell interpretation.
 * @param environment Child-process environment.
 * @param maxBytes Maximum combined stdout and stderr bytes.
 * @returns Captured stdout and decoded stderr after a successful exit.
 */
export async function runCommand(
  executable: string,
  args: readonly string[],
  environment: NodeJS.ProcessEnv,
  maxBytes: number,
): Promise<CommandResult> {
  return await new Promise<CommandResult>((resolve, reject) => {
    const child = spawn(executable, [...args], {
      env: environment,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    const stdout: Buffer[] = []
    const stderr: Buffer[] = []
    let bytes = 0
    const collect = (target: Buffer[], chunk: Buffer): void => {
      bytes += chunk.length
      if (bytes > maxBytes) {
        child.kill('SIGKILL')
        return
      }
      target.push(chunk)
    }
    child.stdout.on('data', (chunk: Buffer) => { collect(stdout, chunk) })
    child.stderr.on('data', (chunk: Buffer) => { collect(stderr, chunk) })
    child.once('error', reject)
    child.once('exit', (code, signal) => {
      if (bytes > maxBytes) {
        reject(new Error('marketplace command output exceeded its byte limit'))
        return
      }
      const diagnostic = Buffer.concat(stderr).toString('utf8').trim()
      if (code !== 0) {
        const output = Buffer.concat(stdout).toString('utf8').trim()
        reject(new Error(`marketplace command failed with ${String(code ?? signal)}: ${[diagnostic, output].filter(Boolean).join('\n')}`))
        return
      }
      resolve({ stdout: Buffer.concat(stdout), stderr: diagnostic })
    })
  })
}
