import { describe, expect, it } from 'vitest'
import { generatedImage } from '../src/image-generation.ts'

describe('Codex image generation projection', () => {
  it('accepts a completed PNG and strips the local path from its name', () => {
    const image = generatedImage({
      item: {
        type: 'imageGeneration',
        id: 'image-1',
        status: 'completed',
        result: 'iVBORw0KGgo=',
        savedPath: '/Users/person/.codex/generated_images/thread/private.png',
      },
    })
    expect(image).toMatchObject({ id: 'image-1', name: 'private.png' })
    expect(Array.from(image?.bytes ?? [])).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  })

  it('accepts a PNG data URL and rejects incomplete, invalid, or non-PNG results', () => {
    expect(generatedImage({ item: { type: 'imageGeneration', id: 'ok', status: 'completed', result: 'data:image/png;base64,iVBORw0KGgo=' } })?.name).toBe('codex-generated.png')
    expect(generatedImage({ item: { type: 'imageGeneration', id: 'pending', status: 'in_progress', result: 'iVBORw0KGgo=' } })).toBeUndefined()
    expect(generatedImage({ item: { type: 'imageGeneration', id: 'bad', status: 'completed', result: 'bm90IGEgcG5n' } })).toBeUndefined()
    expect(generatedImage({ item: { type: 'agentMessage', id: 'text', status: 'completed', result: 'iVBORw0KGgo=' } })).toBeUndefined()
  })
})
