import { describe, expect, it } from 'vitest'
import { ATLAS_V1, ATLAS_V2, atlasForDimensions, rowCountForVersion } from '../src/shared/atlas.js'

describe('atlas', () => {
  it('selects v1 by pixel dimensions', () => {
    expect(atlasForDimensions(1536, 1872)?.version).toBe(1)
  })

  it('selects v2 by pixel dimensions', () => {
    expect(atlasForDimensions(1536, 2288)?.version).toBe(2)
  })

  it('returns null for unknown dimensions', () => {
    expect(atlasForDimensions(1000, 1000)).toBeNull()
  })

  it('v1 and v2 share the cell and column geometry', () => {
    expect(ATLAS_V1.cellWidth).toBe(192)
    expect(ATLAS_V1.cellHeight).toBe(208)
    expect(ATLAS_V1.columns).toBe(8)
    expect(ATLAS_V2.columns).toBe(8)
  })

  it('v2 requiredFramesByRow keeps review row at 6 frames', () => {
    expect(ATLAS_V2.requiredFramesByRow).toEqual([6, 8, 8, 4, 5, 8, 6, 6, 6, 8, 8])
  })

  it('maps version to row count with v1 default', () => {
    expect(rowCountForVersion(2)).toBe(11)
    expect(rowCountForVersion(1)).toBe(9)
    expect(rowCountForVersion(undefined)).toBe(9)
  })
})
