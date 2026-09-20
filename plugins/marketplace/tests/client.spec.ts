import { expect, it, vi } from 'vitest'
import { apply } from '../src/client/index.ts'
import { zh } from '../src/client/locales.ts'

vi.mock('../src/client/MarketplacePanel.tsx', () => ({ MarketplacePanel: () => null }))

it('keeps the native marketplace registered and adds an optional remote tab without making requests', () => {
  const native = { id: 'marketplace', label: () => '插件市场' }
  const tabs = new Map<string, Record<string, unknown>>([['marketplace', native]])
  const call = vi.fn()
  apply({
    effect: callback => { callback() },
    locale: { register: vi.fn(), bind: () => key => zh[key] },
    connection: { rpc: { call } },
    slots: {
      inject: (slot, register) => { expect(slot).toBe('settings.plugins.tab'); register() },
      register: meta => { tabs.set(meta.id as string, meta) },
    },
  })
  expect(tabs.size).toBe(2)
  expect(tabs.get('marketplace')).toBe(native)
  expect(tabs.get('trusted-marketplace')).toMatchObject({ name: 'settings.plugins.tab' })
  const label = tabs.get('trusted-marketplace')?.label as () => string
  expect(label()).toBe('远端市场')
  expect(call).not.toHaveBeenCalled()
})
