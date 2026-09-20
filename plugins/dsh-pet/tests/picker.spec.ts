import { describe, expect, it } from 'vitest'
import type { PetPack } from '../src/packs.js'
import { petListItem, resolveSpritePetId } from '../src/server.js'
import { canonicalPetId, PET_SPRITE_PATH } from '../src/shared/picker.js'
import { parsePets } from '../src/client/controller.js'

function pack(overrides: Partial<PetPack> = {}): PetPack {
  return {
    id: 'xiaobai',
    displayName: '小白',
    spriteVersionNumber: 2,
    spritesheetPath: 'spritesheet.webp',
    directory: '/packs/xiaobai',
    spriteWidth: 1536,
    spriteHeight: 2288,
    ...overrides,
  }
}

describe('resolveSpritePetId', () => {
  it('resolves a known pack id', () => {
    expect(resolveSpritePetId(`${PET_SPRITE_PATH}/xiaobai`, [pack()])).toBe('xiaobai')
  })

  it('rejects unknown ids', () => {
    expect(resolveSpritePetId(`${PET_SPRITE_PATH}/missing`, [pack()])).toBeNull()
  })

  it('rejects traversal and empty segments', () => {
    expect(resolveSpritePetId(`${PET_SPRITE_PATH}/../etc/passwd`, [pack()])).toBeNull()
    expect(resolveSpritePetId(`${PET_SPRITE_PATH}/`, [pack()])).toBeNull()
    expect(resolveSpritePetId('/api/desktop-pet/packs', [pack()])).toBeNull()
  })

  it('rejects encoded traversal that decodes to a non-whitelisted id', () => {
    expect(resolveSpritePetId(`${PET_SPRITE_PATH}/xiaobai%2F..`, [pack()])).toBeNull()
  })
})

describe('canonicalPetId', () => {
  it('maps the two retired bundled ids and preserves all other ids', () => {
    expect(canonicalPetId('langma')).toBe('xiaobai')
    expect(canonicalPetId('langma-no-wave')).toBe('xiaobai-no-wave')
    expect(canonicalPetId('maltese')).toBe('maltese')
  })
})

describe('petListItem', () => {
  it('projects a pack into the picker row', () => {
    const item = petListItem(pack())
    expect(item).toEqual({
      id: 'xiaobai',
      displayName: '小白',
      version: 2,
      spriteUrl: `${PET_SPRITE_PATH}/xiaobai`,
      spriteWidth: 1536,
      spriteHeight: 2288,
      cellWidth: 192,
      cellHeight: 208,
    })
  })

  it('defaults version to 1 and keeps width/height from the pack', () => {
    const p = pack({ spriteWidth: 1536, spriteHeight: 1872 })
    delete p.spriteVersionNumber
    const item = petListItem(p)
    expect(item.version).toBe(1)
    expect(item.spriteHeight).toBe(1872)
  })
})

describe('parsePets', () => {
  it('accepts well-formed rows', () => {
    expect(parsePets([{
      id: 'xiaobai', displayName: '小白', version: 2, spriteUrl: '/s/xiaobai',
      spriteWidth: 1536, spriteHeight: 2288, cellWidth: 192, cellHeight: 208,
    }])).toEqual([{
      id: 'xiaobai', displayName: '小白', version: 2, spriteUrl: '/s/xiaobai',
      spriteWidth: 1536, spriteHeight: 2288, cellWidth: 192, cellHeight: 208,
    }])
  })

  it('drops malformed entries', () => {
    expect(parsePets([
      { id: 'ok', displayName: '好', spriteUrl: '/s/ok', spriteWidth: 1536, spriteHeight: 2288, cellWidth: 192, cellHeight: 208 },
      { id: '', displayName: '坏', spriteUrl: '/s/bad', spriteWidth: 1536, spriteHeight: 2288, cellWidth: 192, cellHeight: 208 },
      null,
      { id: 'no-url' },
      'nope',
    ])).toHaveLength(1)
  })

  it('returns empty for non-arrays', () => {
    expect(parsePets(undefined)).toEqual([])
    expect(parsePets({})).toEqual([])
    expect(parsePets('x')).toEqual([])
  })
})
