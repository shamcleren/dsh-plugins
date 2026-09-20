import { describe, expect, it } from 'vitest'
import {
  backgroundPosition,
  backgroundSize,
  lookFrame,
  sequenceFor,
  __internal,
} from '../src/shared/animation.js'

const { XLO, JLO, YLO } = __internal

describe('frame builder (i4)', () => {
  it('uses base duration for all but the last frame', () => {
    const frames = __internal.i4(5, 8, 140, 240)
    expect(frames).toHaveLength(8)
    expect(frames.map(f => f.frameDurationMs)).toEqual([140, 140, 140, 140, 140, 140, 140, 240])
    expect(frames[0]).toMatchObject({ rowIndex: 5, columnIndex: 0 })
    expect(frames[7]).toMatchObject({ rowIndex: 5, columnIndex: 7 })
  })
})

describe('state frame map (Xlo)', () => {
  it('matches the decoded row→frames contract', () => {
    expect(XLO.failed.map(f => [f.rowIndex, f.frameDurationMs])).toEqual([
      [5, 140], [5, 140], [5, 140], [5, 140], [5, 140], [5, 140], [5, 140], [5, 240],
    ])
    expect(XLO.jumping.map(f => f.frameDurationMs)).toEqual([140, 140, 140, 140, 280])
    expect(XLO.review).toHaveLength(6)
    expect(XLO.running).toHaveLength(6)
    expect(XLO.waving).toHaveLength(4)
    expect(XLO.waiting).toHaveLength(6)
  })

  it('maps drag locomotion to running-left (row 2) and running-right (row 1)', () => {
    expect(XLO['running-left'].map(f => [f.rowIndex, f.frameDurationMs])).toEqual([
      [2, 120], [2, 120], [2, 120], [2, 120], [2, 120], [2, 120], [2, 120], [2, 220],
    ])
    expect(XLO['running-right'].map(f => [f.rowIndex, f.frameDurationMs])).toEqual([
      [1, 120], [1, 120], [1, 120], [1, 120], [1, 120], [1, 120], [1, 120], [1, 220],
    ])
    expect(sequenceFor('running-left').loopStartIndex).toBe(8 * 3)
    expect(sequenceFor('running-right').loopStartIndex).toBe(8 * 3)
  })
})

describe('sequenceFor', () => {
  it('static preview is a single first frame with no loop', () => {
    for (const state of ['idle', 'running', 'failed'] as const) {
      const seq = sequenceFor(state, true)
      expect(seq.loopStartIndex).toBeNull()
      expect(seq.frames).toHaveLength(1)
    }
  })

  it('idle loops YLO from index 0', () => {
    const seq = sequenceFor('idle')
    expect(seq.frames).toEqual(YLO)
    expect(seq.loopStartIndex).toBe(0)
  })

  it('non-idle triples state frames then appends YLO', () => {
    const seq = sequenceFor('running')
    const n = XLO.running
    expect(seq.loopStartIndex).toBe(n.length * 3)
    expect(seq.frames).toEqual([...n, ...n, ...n, ...YLO])
  })

  it('YLO is JLO with 6× durations', () => {
    expect(YLO).toHaveLength(JLO.length)
    expect(YLO[0]!.frameDurationMs).toBe(JLO[0]!.frameDurationMs * 6)
  })
})

describe('backgroundPosition / backgroundSize', () => {
  it('positions columns across 7 steps and rows across rowCount-1', () => {
    expect(backgroundPosition({ columnIndex: 0, rowIndex: 0, frameDurationMs: 0 }, 11)).toBe('0% 0%')
    expect(backgroundPosition({ columnIndex: 7, rowIndex: 10, frameDurationMs: 0 }, 11)).toBe('100% 100%')
    expect(backgroundPosition({ columnIndex: 4, rowIndex: 5, frameDurationMs: 0 }, 9)).toBe(
      `${(4 / 7) * 100}% ${(5 / 8) * 100}%`,
    )
  })

  it('background-size scales to 8 columns and rowCount rows', () => {
    expect(backgroundSize(11)).toBe('800% 1100%')
    expect(backgroundSize(9)).toBe('800% 900%')
  })
})

describe('lookFrame', () => {
  const rect = { left: 0, top: 0, width: 100, height: 100 }

  it('returns null for v1', () => {
    expect(lookFrame(rect, { x: 60, y: 50 }, 1)).toBeNull()
  })

  it('returns null inside the dead zone', () => {
    expect(lookFrame(rect, { x: 50, y: 50 }, 2)).toBeNull()
  })

  it('maps the four cardinal directions to the expected look rows', () => {
    // Cursor to the right → angle 90° → bucket 4.
    const right = lookFrame(rect, { x: 200, y: 50 }, 2)
    expect(right).toMatchObject({ rowIndex: 9, columnIndex: 4 })

    // Cursor straight up → angle 0° → bucket 0.
    const up = lookFrame(rect, { x: 50, y: -200 }, 2)
    expect(up).toMatchObject({ rowIndex: 9, columnIndex: 0 })
  })

  it('never exceeds the look rows or columns', () => {
    for (let angle = 0; angle < 360; angle += 5) {
      const rad = (angle * Math.PI) / 180
      const cursor = { x: 50 + Math.cos(rad) * 500, y: 50 - Math.sin(rad) * 500 }
      const frame = lookFrame(rect, cursor, 2)
      expect(frame).not.toBeNull()
      expect(frame!.rowIndex).toBeGreaterThanOrEqual(9)
      expect(frame!.rowIndex).toBeLessThanOrEqual(10)
      expect(frame!.columnIndex).toBeGreaterThanOrEqual(0)
      expect(frame!.columnIndex).toBeLessThanOrEqual(7)
    }
  })
})
