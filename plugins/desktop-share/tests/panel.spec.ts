import { expect, it } from 'vitest'
import { panelCSS, panelPlacement } from '../src/client/panel.js'

it('pins the share box to the top-right of the window', () => {
  expect(panelPlacement).toMatchObject({ position: 'fixed', top: 60, right: 16, left: 'auto', zIndex: 100 })
  expect(panelCSS).toContain('position:fixed')
  expect(panelCSS).toContain('top:60px')
  expect(panelCSS).toContain('right:16px')
  expect(panelCSS).toContain('left:auto')
})
