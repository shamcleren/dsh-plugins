import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { MarketplaceService } from '../src/service.ts'
import { OAuthCallbackListener } from '../src/oauth-callback.ts'
import { GongfengOAuthController } from '../src/oauth.ts'
import { runCommand } from '../src/command.ts'

const paths = vi.hoisted(() => ({ home: '' }))
vi.mock('@deepseek-ai/cordis', async importOriginal => ({ ...await importOriginal<object>(),
  Service: class { constructor(readonly ctx: unknown) {} },
}))
vi.mock('@deepseek-ai/dsh-app-boot', () => ({ resolveProfileDir: () => join(paths.home, 'profiles/web') }))
vi.mock('@deepseek-ai/dsh-home-paths', () => ({ resolveDshHome: () => paths.home }))
vi.mock('../src/command.ts', () => ({ runCommand: vi.fn() }))

afterEach(async () => { vi.restoreAllMocks(); if (paths.home) await rm(paths.home, { recursive: true, force: true }) })

async function fixture() {
  paths.home = await mkdtemp(join(tmpdir(), 'marketplace-source-'))
  const config: Record<string, unknown> = {}
  const update = vi.fn(async value => { Object.assign(config, value) })
  const describe = vi.fn(async () => ({ configured: false, writable: true }))
  const ctx = {
    credentials: { describe },
    effect: (callback: () => unknown) => { callback() },
    webServer: { port: 3187, register: vi.fn() },
    inject: (_keys: unknown, callback: (scope: unknown) => void) => callback({
      settings: { register: () => ({ get: () => config, update }) }, effect: (callback: () => unknown) => { callback() },
    }),
  }
  return { service: new MarketplaceService(ctx as never), config, update, describe }
}

it('saves only the selected authorized repository and automatically resolves its default branch', async () => {
  const f = await fixture()
  const read = vi.spyOn(GongfengOAuthController.prototype, 'repository').mockResolvedValue({
    id: 12, name: 'plugins', path: 'team/plugins', defaultBranch: 'develop',
  })
  await f.service.configure({ repositoryUrl: 'https://gitlab.example.com/team/plugins.git' })
  expect(read.mock.calls[0]?.[1]).toBe('team/plugins')
  expect(f.update).toHaveBeenCalledExactlyOnceWith({ baseUrl: 'https://gitlab.example.com/', repository: 'team/plugins', ref: 'develop' })
})

it('failed access or an empty repository cannot overwrite the previous source', async () => {
  const f = await fixture()
  const read = vi.spyOn(GongfengOAuthController.prototype, 'repository').mockRejectedValue(new Error('403'))
  await expect(f.service.configure({ repositoryUrl: 'https://gitlab.example.com/team/denied' })).rejects.toThrow('403')
  read.mockResolvedValue({ id: 12, name: 'empty', path: 'team/empty' })
  await expect(f.service.configure({ repositoryUrl: 'https://gitlab.example.com/team/empty' })).rejects.toThrow('default branch')
  expect(f.update).not.toHaveBeenCalled()
})

it('uses the registered callback port independently of the Host port, without changing the saved source', async () => {
  const f = await fixture()
  const listen = vi.spyOn(OAuthCallbackListener.prototype, 'start').mockResolvedValue()
  const flow = await f.service.beginOAuth({ repositoryUrl: 'https://gitlab.example.com/team/plugins' })
  const url = new URL(flow.authorizationUrl)
  expect(url.searchParams.get('client_id')).toBe('78a69ee90433425fbd1cad0fe687c2e6')
  expect(url.searchParams.get('redirect_uri')).toBe('http://127.0.0.1:3080/oauth/gongfeng/callback')
  expect(listen).toHaveBeenCalledOnce()
  expect(f.update).not.toHaveBeenCalled()
  await expect(f.service.beginOAuth({ repositoryUrl: 'https://other.example/team/plugins' })).rejects.toThrow()
})

it('does not inspect or accept legacy private tokens as OAuth authorization', async () => {
  const f = await fixture()
  const state = await f.service.state()
  expect(state.oauthConfigured).toBe(false)
  expect(state).not.toHaveProperty('tokenConfigured')
  expect(f.describe).toHaveBeenCalledExactlyOnceWith('GONGFENG_OAUTH_ACCESS_TOKEN')
})

it('passes the profile store and linker to the official CLI when the desktop environment has different defaults', async () => {
  const f = await fixture()
  const profile = join(paths.home, 'profiles/web')
  await mkdir(join(profile, 'node_modules'), { recursive: true })
  await writeFile(join(profile, 'node_modules/.modules.yaml'), JSON.stringify({ storeDir: '/private/tmp/installer-store/v11', nodeLinker: 'hoisted' }))
  vi.spyOn(f.service, 'catalog').mockResolvedValue({ repository: 'team/plugins', ref: 'main', plugins: [{ packageName: '@example/test' } as never] })
  vi.mocked(runCommand).mockResolvedValue({ stdout: Buffer.alloc(0), stderr: '' })
  await f.service.deletePackage('@example/test')
  expect(vi.mocked(runCommand).mock.calls.at(-1)?.[1]).toEqual(expect.arrayContaining([
    '--config.ignore-scripts=true', '--store-dir', '/private/tmp/installer-store/v11', '--config.node-linker=hoisted', 'remove', '@example/test',
  ]))
})
