import { describe, expect, it } from 'vitest'
import { parsePetManifest } from '../src/shared/manifest.js'

const validV2 = JSON.stringify({
  id: 'maltese',
  displayName: 'maltese',
  description: 'A Maltese pet',
  spriteVersionNumber: 2,
  spritesheetPath: 'spritesheet.webp',
})

const validV1 = JSON.stringify({
  id: 'pikachu-local',
  displayName: 'pikachu-local',
  spritesheetPath: 'spritesheet.webp',
})

describe('parsePetManifest', () => {
  it('parses a v2 manifest', () => {
    expect(parsePetManifest(validV2)).toEqual({
      id: 'maltese',
      displayName: 'maltese',
      description: 'A Maltese pet',
      kind: undefined,
      spriteVersionNumber: 2,
      spritesheetPath: 'spritesheet.webp',
    })
  })

  it('defaults omitted spriteVersionNumber to undefined (v1)', () => {
    const parsed = parsePetManifest(validV1)
    expect(parsed.spriteVersionNumber).toBeUndefined()
  })

  it('rejects malformed JSON', () => {
    expect(() => parsePetManifest('{')).toThrow('not valid JSON')
  })

  it('rejects a non-object', () => {
    expect(() => parsePetManifest('[]')).toThrow('JSON object')
  })

  it('rejects an invalid id', () => {
    expect(() => parsePetManifest(JSON.stringify({ id: '../etc', displayName: 'x', spritesheetPath: 's.webp' }))).toThrow(
      'id must be',
    )
  })

  it('rejects a missing spritesheetPath', () => {
    expect(() => parsePetManifest(JSON.stringify({ id: 'a', displayName: 'x' }))).toThrow('spritesheetPath')
  })

  it('rejects an invalid spriteVersionNumber', () => {
    expect(() =>
      parsePetManifest(JSON.stringify({ id: 'a', displayName: 'x', spriteVersionNumber: 3, spritesheetPath: 's' })),
    ).toThrow('spriteVersionNumber')
  })
})
