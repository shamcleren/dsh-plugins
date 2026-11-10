import { z } from 'zod'
import type { Account, Login, Owner, Repository } from './types.js'
import { WorkspaceError } from './types.js'
import type { Execute, CommandOptions, Result } from './process.js'

export const repositoryName = z.string().max(180).regex(/^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9_.-]{1,100}$/).refine(name => !['.', '..'].includes(name.split('/')[1]!))
const accountSchema = z.object({ login: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/), id: z.number().int().positive() })
const repoSchema = z.object({ full_name: repositoryName, private: z.boolean(), default_branch: z.string().min(1).max(255), permissions: z.object({ push: z.boolean() }).optional() })

export class GitHub {
  login: Login | null = null
  private loginAbort: AbortController | undefined
  private loginTask: Promise<void> | undefined
  constructor(private readonly run: Execute, private readonly options: () => CommandOptions) {}
  private async api(path: string): Promise<unknown> {
    const result = await this.run('gh', ['api', '--hostname', 'github.com', path], { ...this.options(), timeoutMs: 15_000 })
    if (result.code !== 0) throw new WorkspaceError('signIn')
    try { return JSON.parse(result.stdout) as unknown } catch { throw new WorkspaceError('commandFailed') }
  }
  async account(): Promise<Account> { return accountSchema.parse(await this.api('/user')) }
  async owners(): Promise<Owner[]> {
    const account = await this.account(), owners: Owner[] = [{ login: account.login, kind: 'personal' }]
    for (let page = 1; page <= 10; page++) {
      const organizations = z.array(z.object({ login: accountSchema.shape.login })).max(100).parse(await this.api(`/user/orgs?per_page=100&page=${page}`))
      owners.push(...organizations.map(org => ({ login: org.login, kind: 'organization' as const })))
      if (organizations.length < 100) break
    }
    owners.push({ login: '', kind: 'collaborator' })
    return owners
  }
  async repositories(page: number, owner?: Owner): Promise<Repository[]> {
    let path = `/user/repos?per_page=30&sort=updated&page=${page}`
    if (owner?.kind === 'personal') {
      if ((await this.account()).login.toLowerCase() !== owner.login.toLowerCase()) throw new WorkspaceError('invalidRequest')
      path += '&affiliation=owner'
    } else if (owner?.kind === 'organization') path = `/orgs/${accountSchema.shape.login.parse(owner.login)}/repos?type=all&per_page=30&sort=updated&page=${page}`
    else if (owner?.kind === 'collaborator') path += '&affiliation=collaborator'
    return z.array(repoSchema).max(30).parse(await this.api(path)).map(repo => ({
      fullName: repo.full_name, private: repo.private, writable: repo.permissions?.push ?? false, defaultBranch: repo.default_branch,
    }))
  }
  async repository(fullName: string): Promise<Repository> {
    const repo = repoSchema.parse(await this.api('/repos/' + repositoryName.parse(fullName)))
    if (repo.full_name.toLowerCase() !== fullName.toLowerCase()) throw new WorkspaceError('wrongRemote')
    return { fullName: repo.full_name, private: repo.private, writable: repo.permissions?.push ?? false, defaultBranch: repo.default_branch }
  }
  beginLogin(): Login {
    if (this.loginTask) return { ...this.login! }
    const abort = new AbortController(), options = this.options()
    this.loginAbort = abort
    this.login = { status: 'pending' }
    let output = ''
    this.loginTask = this.run('gh', ['auth', 'login', '--hostname', 'github.com', '--git-protocol', 'https', '--web', '--skip-ssh-key'], {
      ...options, env: { ...options.env, GH_BROWSER: 'true', BROWSER: 'true' },
      signal: AbortSignal.any([abort.signal, ...(options.signal ? [options.signal] : [])]), timeoutMs: 10 * 60_000, maxBytes: 32_768,
      onOutput: text => {
        output = (output + text).slice(-8192)
        const code = /\b[A-Z0-9]{4}-[A-Z0-9]{4}\b/.exec(output)?.[0]
        if (code && this.login?.status === 'pending') this.login.code = code
      },
    }).then((result: Result) => { this.login = { status: result.code === 0 ? 'complete' : 'failed' } }, () => { this.login = { status: 'failed' } })
      .finally(() => { this.loginTask = undefined; this.loginAbort = undefined })
    return { ...this.login }
  }
  async cancelLogin(): Promise<void> { this.loginAbort?.abort(); await this.loginTask }
}
