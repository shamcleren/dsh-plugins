import { lstat, mkdir, readFile, unlink, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join } from 'node:path'
import { git } from './repository.js'

export const DEFAULT_EDIT_TOOLS = ['write', 'edit', 'str_replace_editor', 'write_file', 'edit_file', 'apply_patch']
/** The official multi-command editor also has a read-only view operation. */
export function isConfiguredEdit(name: string, args: unknown, names: readonly string[]): boolean {
  if (!names.includes(name) || name.startsWith('security_')) return false
  if (name !== 'str_replace_editor') return true
  if (!args || typeof args !== 'object' || !('command' in args)) return false
  return ['create', 'str_replace', 'insert'].includes(String(args.command))
}

const marker = '# dsh-security-scan managed hook v1'
const quote = (value: string): string => "'" + value.replaceAll("'", "'\\''") + "'"
export async function manageHook(options: { target: string; action: 'install' | 'remove'; event: 'pre-commit' | 'pre-push'; cli: string; output: string; semgrepPath: string; enforce: boolean; base?: string; signal: AbortSignal }): Promise<string> {
  const top = (await git(options.target, ['rev-parse', '--show-toplevel'], options.signal)).trim()
  const custom = (await git(top, ['config', '--local', '--get', 'core.hooksPath'], options.signal, true)).trim()
  if (custom) throw new Error('Repository uses core.hooksPath. Add the documented scan command to your existing hook manager; it will not be overwritten.')
  const global = (await git(top, ['config', '--global', '--get', 'core.hooksPath'], options.signal, true)).trim()
  if (global) throw new Error('Global core.hooksPath is configured; preserve your hook manager and add the scan command there.')
  const common = (await git(top, ['rev-parse', '--path-format=absolute', '--git-common-dir'], options.signal)).trim()
  const path = join(common, 'hooks', options.event)
  await mkdir(dirname(path), { recursive: true })
  if ((await lstat(dirname(path))).isSymbolicLink()) throw new Error('Hook directory cannot be a symlink')
  let content: string | undefined
  try { const stat = await lstat(path); if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Unsafe hook path'); content = await readFile(path, 'utf8') } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
  if (options.action === 'remove') {
    if (content === undefined) return 'Hook is not installed'
    if (!content.startsWith('#!/bin/sh\n' + marker + '\n')) throw new Error('Refusing to remove an existing user hook')
    await unlink(path); return 'Removed managed ' + options.event + ' hook'
  }
  if (![options.cli, options.output].every(isAbsolute)) throw new Error('Hook executable and output paths must be absolute')
  if (options.event === 'pre-push' && !options.base) throw new Error('pre-push requires --base <target-branch>; no target is guessed')
  const args = ['scan', '--target', top, '--scope', options.event === 'pre-commit' ? 'staged' : 'diff', '--output', options.output, '--semgrep', options.semgrepPath]
  if (options.event === 'pre-push') args.push('--base', options.base!)
  const invocation = quote(process.execPath) + ' ' + quote(options.cli) + ' ' + args.map(quote).join(' ')
  const record = 'result=$?\nif [ "$result" -gt "$status" ]; then status=$result; fi\n'
  const body = '#!/bin/sh\n' + marker + '\n# Explicit local opt-in; existing hooks are never overwritten.\nunset NODE_OPTIONS NODE_PATH\nstatus=0\n' +
    (options.event === 'pre-push'
      ? 'while read -r local_ref local_oid remote_ref remote_oid; do\ncase "$local_oid" in 0000000000000000000000000000000000000000|0000000000000000000000000000000000000000000000000000000000000000) continue ;; esac\n' + invocation + ' --ref "$local_oid"\n' + record + 'done\n'
      : invocation + '\n' + record) +
    (options.enforce ? 'exit "$status"\n' : 'if [ "$status" -ne 0 ]; then printf "%s\\n" "Security scan needs attention; report or diagnostics above. Hook is advisory." >&2; fi\nexit 0\n')
  if (content === body) return 'Managed hook already up to date'
  if (content !== undefined) throw new Error('Hook exists; remove this plugin\'s old hook explicitly before changing it. User hooks are never replaced.')
  await writeFile(path, body, { flag: 'wx', mode: 0o700 })
  return 'Installed ' + options.event + ' hook (' + (options.enforce ? 'enforced' : 'advisory') + ')'
}
/** One owned job per workspace; coalesce edits and cancel all work on disposal. */
export class AuditQueue {
  private states = new Map<string, { timer?: ReturnType<typeof setTimeout>; running?: Promise<void>; dirty: boolean }>()
  private stopped = false
  readonly abort = new AbortController()
  constructor(private readonly run: (workspace: string, signal: AbortSignal) => Promise<void>, private readonly failure: () => void, private readonly delay = 1000) {}
  enqueue(workspace: string): void {
    if (this.stopped) return
    const state = this.states.get(workspace) ?? { dirty: false }
    this.states.set(workspace, state); state.dirty = true
    if (state.running) return
    clearTimeout(state.timer)
    state.timer = setTimeout(() => {
      delete state.timer; state.dirty = false
      state.running = this.run(workspace, this.abort.signal).catch(() => { if (!this.stopped) this.failure() }).finally(() => {
        delete state.running
        if (state.dirty && !this.stopped) this.enqueue(workspace)
        else this.states.delete(workspace)
      })
    }, this.delay)
  }
  async stop(): Promise<void> {
    this.stopped = true; this.abort.abort()
    for (const state of this.states.values()) clearTimeout(state.timer)
    await Promise.allSettled([...this.states.values()].flatMap(state => state.running ? [state.running] : []))
    this.states.clear()
  }
}
