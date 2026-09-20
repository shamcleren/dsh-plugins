import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { retireBundledAlias, syncPacks } from '../src/packs.js'

const temporaryDirectories: string[] = []
const bundledPacksDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'assets', 'pets')

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

describe('bundled pet packs', () => {
  it('copies and validates every built-in pet', async () => {
    const target = await mkdtemp(join(tmpdir(), 'dsh-pet-bundled-'))
    temporaryDirectories.push(target)

    const result = await syncPacks(bundledPacksDir, target)

    expect(result.errors).toEqual([])
    expect(Object.fromEntries(
      result.packs.map(pack => [pack.id, pack.spriteVersionNumber ?? 1]),
    )).toEqual({
      xiaobai: 2,
      'xiaobai-no-wave': 2,
      maltese: 2,
      'pikachu-local': 1,
      xiaohuang_webp: 1,
    })
  })

  it('treats a missing optional import directory as empty', async () => {
    const target = await mkdtemp(join(tmpdir(), 'dsh-pet-optional-'))
    temporaryDirectories.push(target)

    const result = await syncPacks(join(target, 'missing'), target, { missingSourceIsError: false })

    expect(result).toEqual({ packs: [], errors: [] })
  })

  it('does not import retired aliases from an external pet directory', async () => {
    const source = await mkdtemp(join(tmpdir(), 'dsh-pet-source-'))
    const target = await mkdtemp(join(tmpdir(), 'dsh-pet-target-'))
    temporaryDirectories.push(source, target)
    await cp(join(bundledPacksDir, 'xiaobai'), join(source, 'legacy'), { recursive: true })
    const manifestFile = join(source, 'legacy', 'pet.json')
    const manifest = JSON.parse(await readFile(manifestFile, 'utf8')) as Record<string, unknown>
    manifest.id = 'langma'
    await writeFile(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')

    const result = await syncPacks(source, target, { excludedIds: ['langma'] })

    expect(result).toEqual({ packs: [], errors: [] })
  })

  it('retires only an unchanged legacy bundled pack', async () => {
    const target = await mkdtemp(join(tmpdir(), 'dsh-pet-migration-'))
    temporaryDirectories.push(target)
    await cp(join(bundledPacksDir, 'xiaobai'), join(target, 'langma'), { recursive: true })
    const manifestFile = join(target, 'langma', 'pet.json')
    const manifest = JSON.parse(await readFile(manifestFile, 'utf8')) as Record<string, unknown>
    manifest.id = 'langma'
    await writeFile(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')

    expect(await retireBundledAlias(target, 'langma', join(bundledPacksDir, 'xiaobai'))).toBe(true)
    expect((await syncPacks(bundledPacksDir, target)).packs.map(pack => pack.id)).not.toContain('langma')
  })

  it('preserves a user-modified legacy pack during migration', async () => {
    const target = await mkdtemp(join(tmpdir(), 'dsh-pet-migration-'))
    temporaryDirectories.push(target)
    await cp(join(bundledPacksDir, 'xiaobai'), join(target, 'langma'), { recursive: true })
    const manifestFile = join(target, 'langma', 'pet.json')
    const manifest = JSON.parse(await readFile(manifestFile, 'utf8')) as Record<string, unknown>
    manifest.id = 'langma'
    await writeFile(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
    await writeFile(join(target, 'langma', 'spritesheet.webp'), Buffer.from('modified'), 'utf8')

    expect(await retireBundledAlias(target, 'langma', join(bundledPacksDir, 'xiaobai'))).toBe(false)
    expect(await readFile(manifestFile, 'utf8')).toContain('langma')
  })
})
