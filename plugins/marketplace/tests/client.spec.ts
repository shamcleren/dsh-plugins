import type { Context } from '@deepseek-ai/cordis'
import { expect, it, vi } from 'vitest'
import { apply, name } from '../src/client/index.ts'
import { zh } from '../src/client/locales.ts'
import { isValidElement } from 'react'

vi.mock('../src/client/MarketplacePanel.tsx', () => ({ MarketplacePanel: () => null }))

it('makes the market reachable on its bundle page when only the current plugin-page slot is mounted', () => {
  const pages = new Map<string, { meta: Record<string, unknown>; render(): unknown }>()
  const call = vi.fn()
  apply({
    effect: (callback: () => unknown) => { callback() },
    locale: { register: vi.fn(), bind: () => (key: keyof typeof zh) => zh[key] },
    get: (service: string) => { expect(service).toBe('connection'); return { rpc: { call } } },
    slots: {
      // An unmounted legacy slot cannot render anything, even if its type remains exported.
      inject: (slot: string, register: () => unknown) => { if (slot === 'plugins.bundle.config') register() },
      register: (meta: Record<string, unknown>, render: () => unknown) => { pages.set(meta.key as string, { meta, render }) },
    },
  } as unknown as Context)
  const page = pages.get(name)
  expect(page?.meta).toMatchObject({ name: 'plugins.bundle.config', key: '@shamcleren/dsh-plugin-marketplace' })
  expect(isValidElement(page?.render())).toBe(true)
  expect(call).not.toHaveBeenCalled()
})
