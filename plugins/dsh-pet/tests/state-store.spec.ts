import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { PanelStateStore, type Position } from '../src/state-store.js'

describe('PanelStateStore', () => {
  it('defaults to a null position', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'desktop-pet-state-'))
    const store = new PanelStateStore(join(dir, 'state.json'))
    const state = await store.load()
    expect(state.position).toBeNull()
    expect(state.positionMode).toBe('panel-origin')
  })

  it('persists and reloads a dragged position', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'desktop-pet-state-'))
    const file = join(dir, 'state.json')
    const position: Position = { x: 123.5, y: 456.25 }
    const store = new PanelStateStore(file)
    await store.update({ position, positionMode: 'pet-anchor' })
    const reloaded = new PanelStateStore(file)
    expect((await reloaded.load()).position).toEqual(position)
    expect((await reloaded.load()).positionMode).toBe('pet-anchor')
  })

  it('ignores malformed saved positions', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'desktop-pet-state-'))
    const file = join(dir, 'state.json')
    await writeFile(file, JSON.stringify({ position: { x: 'a', y: 1 } }), 'utf8')
    const store = new PanelStateStore(file)
    expect((await store.load()).position).toBeNull()
    expect((await store.load()).positionMode).toBe('panel-origin')
  })

  it('ignores legacy petId/petSize fields and keeps only position', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'desktop-pet-state-'))
    const file = join(dir, 'state.json')
    await writeFile(file, JSON.stringify({ petId: 'xiaobai-no-wave', petSize: 112, position: { x: 10, y: 20 } }), 'utf8')
    const store = new PanelStateStore(file)
    expect((await store.load()).position).toEqual({ x: 10, y: 20 })
    expect((await store.load()).positionMode).toBe('panel-origin')
  })
})
