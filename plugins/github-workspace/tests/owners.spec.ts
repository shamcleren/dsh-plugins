import { expect, it } from 'vitest'
import { GitHub } from '../src/github.js'

it('discovers personal and organization owners and pages the selected scope on the server', async () => {
  const requests: string[] = []
  const github = new GitHub(async (_command, args) => {
    const path = args.at(-1)!; requests.push(path)
    const value = path === '/user' ? { id: 1, login: 'me' } : path.startsWith('/user/orgs') ? [{ login: 'team-one' }, { login: 'team-two' }]
      : [{ full_name: path.startsWith('/orgs/team-two/') ? 'team-two/project' : 'me/project', private: true, default_branch: 'main', permissions: { push: true } }]
    return { code: 0, stdout: JSON.stringify(value), stderr: '' }
  }, () => ({}))
  expect(await github.owners()).toEqual([{ login: 'me', kind: 'personal' }, { login: 'team-one', kind: 'organization' }, { login: 'team-two', kind: 'organization' }, { login: '', kind: 'collaborator' }])
  expect((await github.repositories(2, { login: 'team-two', kind: 'organization' }))[0]?.fullName).toBe('team-two/project')
  expect(requests.at(-1)).toBe('/orgs/team-two/repos?type=all&per_page=30&sort=updated&page=2')
  await github.repositories(1, { login: 'me', kind: 'personal' }); expect(requests.at(-1)).toContain('affiliation=owner')
  await github.repositories(1, { login: '', kind: 'collaborator' }); expect(requests.at(-1)).toContain('affiliation=collaborator')
})
