import { createHash } from 'node:crypto'
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
vi.mock('@deepseek-ai/dsh-home-paths', () => ({ resolveDshHome: () => paths.home }))
vi.mock('../src/command.ts', () => ({ runCommand: vi.fn() }))

afterEach(async () => { vi.clearAllMocks(); vi.restoreAllMocks(); vi.unstubAllGlobals(); if (paths.home) await rm(paths.home, { recursive: true, force: true }) })

async function fixture(profileName = 'web') {
  paths.home = await mkdtemp(join(tmpdir(), 'marketplace-source-'))
  const dir = join(paths.home, 'profiles', profileName)
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, 'package.json'), JSON.stringify({ dependencies: {}, dsh: { profile: { bundles: ['@deepseek-ai/dsh-web-app'] } } }))
  const manager = {
    installBundle: vi.fn(async () => ({ application: 'applied', stage: 'install' })),
    removeBundle: vi.fn(async () => ({ application: 'applied', stage: 'remove' })),
    setBundleEnabled: vi.fn(async () => ({ application: 'applied', stage: 'enable' })),
  }
  const config: Record<string, unknown> = {}
  const update = vi.fn(async (_ns, value) => { Object.assign(config, value) })
  const describe = vi.fn(async () => ({ configured: false, writable: true }))
  const ctx = {
    profileContext: { name: profileName, dir, installAnchor: join(process.cwd(), 'package.json') },
    pluginManager: manager,
    credentials: { describe },
    effect: (callback: () => unknown) => { callback() },
    webServer: { port: 3187, register: vi.fn() },
    inject: (_keys: unknown, callback: (scope: unknown) => void) => callback({
      settings: { update }, effect: (callback: () => unknown) => { callback() },
    }),
  }
  return { service: new MarketplaceService(ctx as never, config), config, update, describe, manager, dir }
}

it('saves only the selected authorized repository and automatically resolves its default branch', async () => {
  const f = await fixture()
  const read = vi.spyOn(GongfengOAuthController.prototype, 'repository').mockResolvedValue({
    id: 12, name: 'plugins', path: 'team/plugins', defaultBranch: 'develop',
  })
  await f.service.configure({ repositoryUrl: 'https://gitlab.example.com/team/plugins.git' })
  expect(read.mock.calls[0]?.[1]).toBe('team/plugins')
  expect(f.update).toHaveBeenCalledExactlyOnceWith('trusted-marketplace', { baseUrl: 'https://gitlab.example.com/', repository: 'team/plugins', ref: 'develop' })
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

it('connects a public GitHub repository without Gongfeng OAuth and reads its catalog', async () => {
  const f = await fixture()
  const catalog = Buffer.from(JSON.stringify({ schemaVersion: 1, plugins: [] }))
  const gongfeng = vi.spyOn(GongfengOAuthController.prototype, 'repository')
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    expect(new Headers(init?.headers).has('authorization')).toBe(false)
    const url = String(input)
    if (url === 'https://api.github.com/repos/shamcleren/dsh-plugins') return Response.json({ default_branch: 'main' })
    if (url.startsWith('https://api.github.com/repos/shamcleren/dsh-plugins/contents/marketplace.json')) {
      return Response.json({ type: 'file', size: catalog.length, download_url: 'https://raw.githubusercontent.com/shamcleren/dsh-plugins/main/marketplace.json' })
    }
    return new Response(catalog)
  }))
  const state = await f.service.configure({ repositoryUrl: 'https://github.com/shamcleren/dsh-plugins.git' })
  expect(gongfeng).not.toHaveBeenCalled()
  expect(state).toMatchObject({ host: 'github', repository: 'shamcleren/dsh-plugins', ref: 'main', oauthConfigured: false })
  await expect(f.service.catalog()).resolves.toMatchObject({ repository: 'shamcleren/dsh-plugins', ref: 'main' })
  await expect(f.service.beginOAuth({ repositoryUrl: 'https://github.com/shamcleren/dsh-plugins' })).rejects.toThrow(/without OAuth/)
})

it('does not inspect or accept legacy private tokens as OAuth authorization', async () => {
  const f = await fixture()
  const state = await f.service.state()
  expect(state.oauthConfigured).toBe(false)
  expect(state.host).toBe('gongfeng')
  expect(state).not.toHaveProperty('tokenConfigured')
  expect(f.describe).toHaveBeenCalledExactlyOnceWith('GONGFENG_OAUTH_ACCESS_TOKEN')
})

it.each(['web', 'desktop'])('uses the %s Host manager for removal and propagates its lifecycle', async profile => {
  const f = await fixture(profile)
  f.config.profile = 'some-other-profile'
  vi.spyOn(f.service, 'catalog').mockResolvedValue({ repository: 'team/plugins', ref: 'main', plugins: [{ packageName: '@example/test' } as never] })
  await expect(f.service.deletePackage('@example/test')).resolves.toEqual({ packageName: '@example/test', restartRequired: false })
  expect(f.manager.removeBundle).toHaveBeenCalledExactlyOnceWith('@example/test')
  expect(runCommand).not.toHaveBeenCalled()
  f.manager.removeBundle.mockResolvedValue({ application: 'restart-required', stage: 'remove' })
  expect((await f.service.deletePackage('@example/test')).restartRequired).toBe(true)
  f.manager.removeBundle.mockResolvedValue({ application: 'failed', stage: 'remove' })
  await expect(f.service.deletePackage('@example/test')).rejects.toThrow('failed')
})

it('lists the active Desktop dependencies even when legacy config points at Web', async () => {
  const f = await fixture('desktop')
  f.config.profile = 'web'
  await mkdir(join(f.dir, 'node_modules/@example/test'), { recursive: true })
  await writeFile(join(f.dir, 'package.json'), JSON.stringify({ dependencies: { '@example/test': 'file:test.tgz' } }))
  await writeFile(join(f.dir, 'node_modules/@example/test/package.json'), JSON.stringify({ name: '@example/test', version: '2.0.0' }))
  expect((await f.service.state()).installed).toEqual([{ packageName: '@example/test', specifier: 'file:test.tgz', version: '2.0.0' }])
})

it('refetches the Catalog after an installed plugin changes without changing DSH', async () => {
  const f = await fixture()
  const profile = join(paths.home, 'profiles/web')
  const pkg = join(profile, 'node_modules/@example/test')
  await mkdir(pkg, { recursive: true })
  await writeFile(join(profile, 'package.json'), JSON.stringify({ dependencies: { '@example/test': 'link:/example' } }))
  await writeFile(join(pkg, 'package.json'), JSON.stringify({ version: '1.0.0' }))
  vi.spyOn(GongfengOAuthController.prototype, 'repositoryFile').mockResolvedValue(Buffer.from(JSON.stringify({ commit_id: 'fixture-commit' })))
  const remote = vi.spyOn(GongfengOAuthController.prototype, 'repositoryRawFile').mockResolvedValue(Buffer.from(JSON.stringify({ schemaVersion: 1, plugins: [] })))
  await f.service.catalog()
  await f.service.catalog()
  expect(remote).toHaveBeenCalledTimes(1)
  await writeFile(join(pkg, 'package.json'), JSON.stringify({ version: '1.0.1' }))
  await f.service.catalog()
  expect(remote).toHaveBeenCalledTimes(2)
  await f.service.catalog()
  expect(remote).toHaveBeenCalledTimes(2)
})


it.each(['web', 'desktop'])('installs verified artifacts with the %s manager and preserves required layer order', async profile => {
  const f = await fixture(profile)
  const bytes = Buffer.from('verified fixture'), sha256 = createHash('sha256').update(bytes).digest('hex')
  const cache = join(paths.home, 'plugin-cache')
  await mkdir(cache, { recursive: true })
  await writeFile(join(cache, sha256 + '.tgz'), bytes)
  vi.spyOn(f.service, 'catalog').mockResolvedValue({ repository: 'team/plugins', ref: 'main', plugins: [{
    packageName: '@example/test', compatible: true, placement: 'before-web-app', artifact: { sha256, size: bytes.length },
  } as never] })
  f.manager.installBundle.mockImplementation(async () => {
    await writeFile(join(f.dir, 'package.json'), JSON.stringify({ custom: 'preserved', dependencies: { '@example/test': 'file:fixture' }, dsh: { profile: { bundles: ['@deepseek-ai/dsh-web-app', '@example/test'] } } }))
    return { application: 'applied', stage: 'install' }
  })
  await expect(f.service.add('@example/test')).resolves.toMatchObject({ restartRequired: false })
  expect(f.manager.installBundle).toHaveBeenCalledExactlyOnceWith('@example/test@file:' + join(cache, sha256 + '.tgz'))
  expect(f.manager.setBundleEnabled).toHaveBeenCalledExactlyOnceWith('@example/test', true)
  const manifest = JSON.parse(await (await import('node:fs/promises')).readFile(join(f.dir, 'package.json'), 'utf8'))
  expect(manifest.custom).toBe('preserved')
  expect(manifest.dsh.profile.bundles).toEqual(['@example/test', '@deepseek-ai/dsh-web-app'])
  f.manager.installBundle.mockResolvedValue({ application: 'cancelled', stage: 'install' })
  await expect(f.service.add('@example/test')).rejects.toThrow('cancelled')
  expect(f.manager.setBundleEnabled).toHaveBeenCalledTimes(1)
})
