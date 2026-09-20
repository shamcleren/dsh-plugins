import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { profilePnpmOptions } from '../src/profile-pnpm.ts'

it('retains an existing store and node linker from YAML or JSON metadata without rewriting configuration', async () => {
  const profile = await mkdtemp(join(tmpdir(), 'marketplace-pnpm-'))
  try {
    expect(await profilePnpmOptions(profile)).toEqual([])
    await mkdir(join(profile, 'node_modules'))
    for (const value of ['storeDir: "/private/tmp/a store/v11"\nnodeLinker: hoisted\n',
      JSON.stringify({ storeDir: '/private/tmp/a store/v11', nodeLinker: 'hoisted' })]) {
      await writeFile(join(profile, 'node_modules/.modules.yaml'), value)
      expect(await profilePnpmOptions(profile)).toEqual(['--store-dir', '/private/tmp/a store/v11', '--config.node-linker=hoisted'])
    }
    await writeFile(join(profile, 'node_modules/.modules.yaml'), 'storeDir: relative/path')
    await expect(profilePnpmOptions(profile)).rejects.toThrow()
  } finally { await rm(profile, { recursive: true, force: true }) }
})
