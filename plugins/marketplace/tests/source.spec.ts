import { expect, it } from 'vitest'
import { parseRepositoryUrl } from '../src/source.ts'

it.each(['https://gitlab.example.com/shamcleren/dsh-plugin', ' https://gitlab.example.com/shamcleren/dsh-plugin.git/ '])('normalizes one Gongfeng repository URL: %s', value => {
  expect(parseRepositoryUrl(value)).toEqual({ host: 'gongfeng', baseUrl: 'https://gitlab.example.com/', repository: 'shamcleren/dsh-plugin', repositoryUrl: 'https://gitlab.example.com/shamcleren/dsh-plugin' })
})

it.each(['https://github.com/shamcleren/dsh-plugins', ' https://github.com/shamcleren/dsh-plugins.git/ '])('normalizes one GitHub repository URL: %s', value => {
  expect(parseRepositoryUrl(value)).toEqual({ host: 'github', baseUrl: 'https://github.com/', repository: 'shamcleren/dsh-plugins', repositoryUrl: 'https://github.com/shamcleren/dsh-plugins' })
})

it.each(['http://gitlab.example.com/a/b', 'https://other.example/a/b', 'https://gitlab.example.com.evil.test/a/b',
  'https://user:secret@gitlab.example.com/a/b', 'https://gitlab.example.com:444/a/b', 'https://gitlab.example.com/a/b?ref=main',
  'https://gitlab.example.com/a/b#readme', 'https://gitlab.example.com/a/../b/c', 'https://gitlab.example.com/a/%2e%2e/b',
  'https://gitlab.example.com/a', 'git@gitlab.example.com:a/b.git', 'https://github.com/only-owner',
  'https://github.com/owner/repo/tree/main', 'https://gist.github.com/owner/repo'])('rejects unsupported or unsafe repository address: %s', value => {
  expect(() => parseRepositoryUrl(value)).toThrow()
})
