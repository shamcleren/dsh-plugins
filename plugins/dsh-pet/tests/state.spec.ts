import { describe, expect, it } from 'vitest'
import { supportsLookFrame } from '../src/shared/state.js'

describe('supportsLookFrame', () => {
  it('allows look only in idle/running/waving', () => {
    expect(supportsLookFrame('idle')).toBe(true)
    expect(supportsLookFrame('running')).toBe(true)
    expect(supportsLookFrame('waving')).toBe(true)
    expect(supportsLookFrame('waiting')).toBe(false)
    expect(supportsLookFrame('failed')).toBe(false)
    expect(supportsLookFrame('review')).toBe(false)
    expect(supportsLookFrame('jumping')).toBe(false)
  })
})
