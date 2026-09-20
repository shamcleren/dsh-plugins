import { describe, expect, it } from 'vitest'
import { parseRepositoryFilePointer } from '../src/repository-file.ts'

describe('parseRepositoryFilePointer', () => {
  it('returns the commit identity used by Gongfeng v3 raw reads', () => {
    expect(parseRepositoryFilePointer(Buffer.from(JSON.stringify({
      size: 44_277,
      commit_id: 'af4aaac4f6230d8b76dd9ba50189579e1665b8a4',
    })), 50_000)).toEqual({
      commitId: 'af4aaac4f6230d8b76dd9ba50189579e1665b8a4',
      size: 44_277,
    })
  })

  it('rejects metadata above the requested byte limit', () => {
    expect(() => parseRepositoryFilePointer(Buffer.from(JSON.stringify({
      size: 8,
      commit_id: 'af4aaac4f6230d8b76dd9ba50189579e1665b8a4',
    })), 7)).toThrow(/byte limit/)
  })

  it('requires a commit identity even when inline content exists', () => {
    expect(() => parseRepositoryFilePointer(Buffer.from(JSON.stringify({
      size: 5,
      content: 'aGVsbG8=',
      encoding: 'base64',
    })), 10)).toThrow()
  })
})
