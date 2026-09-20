/** macOS idle-sleep assertion owned by one active Bot connection. */

import { spawn, type ChildProcess } from 'node:child_process'

/** Managed `/usr/bin/caffeinate` assertion; absent on non-macOS deployments. */
export class IdleSleepAssertion {
  private constructor(private readonly child: ChildProcess) {}

  static async start(enabled: boolean): Promise<IdleSleepAssertion | undefined> {
    if (!enabled || process.platform !== 'darwin') return undefined
    const child = spawn('/usr/bin/caffeinate', ['-i', '-w', String(process.pid)], {
      stdio: 'ignore',
    })
    await new Promise<void>((resolve, reject) => {
      child.once('spawn', resolve)
      child.once('error', reject)
    })
    return new IdleSleepAssertion(child)
  }

  async stop(): Promise<void> {
    if (this.child.exitCode !== null || this.child.signalCode !== null) return
    await new Promise<void>((resolve) => {
      this.child.once('exit', () => { resolve() })
      this.child.kill('SIGTERM')
    })
  }
}
