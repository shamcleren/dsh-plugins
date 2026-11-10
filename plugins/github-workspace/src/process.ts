import { spawn } from 'node:child_process'
import { StringDecoder } from 'node:string_decoder'
import { WorkspaceError } from './types.js'

export interface CommandOptions {
  cwd?: string; env?: NodeJS.ProcessEnv; signal?: AbortSignal; timeoutMs?: number; maxBytes?: number;
  captureBinary?: boolean; stdoutLimit?: number;
  input?: string | Buffer;
  onOutput?(text: string): void
}
export interface Result { code: number; stdout: string; stderr: string; stdoutBytes?: Buffer }
export type Execute = (command: string, args: string[], options?: CommandOptions) => Promise<Result>

/** Own the entire command group; reject only after its streams and processes close. */
export const execute: Execute = (command, args, options = {}) => new Promise((resolve, reject) => {
  if (options.signal?.aborted) { reject(new WorkspaceError('stopped')); return }
  const child = spawn(command, args, {
    ...(options.cwd === undefined ? {} : { cwd: options.cwd }), env: options.env,
    detached: process.platform !== 'win32', stdio: [options.input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
  })
  let stdout = '', stderr = '', size = 0, failure: Error | undefined, killTimer: ReturnType<typeof setTimeout> | undefined
  const binary: Buffer[] = []
  const signal = (value: NodeJS.Signals) => {
    if (!child.pid) return
    try { if (process.platform === 'win32') child.kill(value); else process.kill(-child.pid, value) }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') failure ??= new WorkspaceError('commandFailed') }
  }
  const stop = (error: WorkspaceError) => { failure ??= error; signal('SIGTERM'); killTimer ??= setTimeout(() => signal('SIGKILL'), 1000) }
  const abort = () => stop(new WorkspaceError('stopped'))
  child.stdin?.on('error', error => { if ((error as NodeJS.ErrnoException).code !== 'EPIPE') stop(new WorkspaceError('commandFailed')) })
  child.stdin?.end(options.input)
  const timer = setTimeout(() => stop(new WorkspaceError('commandFailed')), options.timeoutMs ?? 60_000)
  options.signal?.addEventListener('abort', abort, { once: true })
  const decoders = [new StringDecoder('utf8'), new StringDecoder('utf8')]
  for (const [stream, isError] of [[child.stdout, false], [child.stderr, true]] as const) stream!.on('data', (chunk: Buffer) => {
    size += chunk.length
    if (size > (options.maxBytes ?? 4 * 1024 * 1024)) { stop(new WorkspaceError('tooLarge')); return }
    if (!isError && options.captureBinary) { binary.push(chunk); return }
    const text = decoders[isError ? 1 : 0]!.write(chunk)
    if (isError) stderr += text; else stdout = (stdout + text).slice(0, options.stdoutLimit)
    options.onOutput?.(text)
  })
  child.once('error', error => {
    failure = (error as NodeJS.ErrnoException).code === 'ENOENT'
      ? new WorkspaceError(command === 'gh' ? 'ghMissing' : command === 'git' ? 'gitMissing' : 'commandFailed') : new WorkspaceError('commandFailed')
  })
  child.once('close', code => {
    stdout = (stdout + decoders[0]!.end()).slice(0, options.stdoutLimit); stderr += decoders[1]!.end()
    clearTimeout(timer); clearTimeout(killTimer); options.signal?.removeEventListener('abort', abort)
    if (failure) reject(failure); else resolve({ code: code ?? -1, stdout, stderr, ...(options.captureBinary ? { stdoutBytes: Buffer.concat(binary) } : {}) })
  })
})

export function commandEnvironment(): NodeJS.ProcessEnv {
  const env = { ...process.env, GH_HOST: 'github.com', GH_PROMPT_DISABLED: '1', GH_NO_UPDATE_NOTIFIER: '1',
    GH_NO_EXTENSION_UPDATE_NOTIFIER: '1', GH_PAGER: 'cat', GIT_TERMINAL_PROMPT: '0', LANG: 'C', LC_ALL: 'C', NO_COLOR: '1' }
  // Inherited tracing can expose credential-helper traffic, and inherited Git
  // routing/index variables must never redirect a managed project operation.
  for (const key of Object.keys(env)) if (/^(?:GIT_|GH_DEBUG$|DEBUG$)/.test(key)) delete env[key as keyof typeof env]
  return { ...env, GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null' }
}
