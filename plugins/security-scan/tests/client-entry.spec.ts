import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { apply } from '../src/client/index.js'
import { Workbench } from '../src/client/Workbench.js'
import { SECURITY_CHANNEL } from '../src/ui-contract.js'

vi.mock('../src/client/Workbench.js', () => ({ Workbench: vi.fn(() => null) }))
vi.mock('react', async load => ({ ...await load<typeof import('react')>(), useSyncExternalStore: vi.fn((_subscribe, read) => read()) }))
beforeEach(() => vi.clearAllMocks())
afterEach(() => vi.unstubAllGlobals())

function fixture() {
  const dispose: Array<() => void> = [], register = vi.fn(), slots = vi.fn((_slot: string, callback: () => void) => callback())
  const registerLocale = vi.fn(), bind = vi.fn(() => (key: string) => key)
  const selectPanel = vi.fn(), openSession = vi.fn()
  apply({ effect: callback => { const result = callback(); if (typeof result === 'function') dispose.push(result as () => void) }, locale: { register: registerLocale, bind },
    connection: { rpc: { call: vi.fn() } }, slots: { inject: slots, register }, layout: { selectPanel }, uiWorkspace: { openSession } })
  return { register, slots, registerLocale, selectPanel, openSession, cleanup: () => { for (const cleanup of dispose.reverse()) cleanup() } }
}

it('joins the host global panel list with a matching main panel and host-owned navigation button', () => {
  const { register, slots, registerLocale, cleanup } = fixture()
  expect(slots.mock.calls.map(call => call[0])).toEqual(['sidebar.panellist', 'main'])
  expect(register.mock.calls.map(call => [call[0].name, call[0].id ?? call[0].key])).toEqual([['sidebar.panellist', 'security-scan'], ['main', 'security-scan']])
  expect(register.mock.calls[0]![0].label()).toBe('entry')
  const icon = register.mock.calls[0]![1]({ size: 24 })
  expect(icon.type).toBe('svg')
  expect(icon.props.width).toBe(24)
  expect(registerLocale).toHaveBeenCalledOnce()
  expect(SECURITY_CHANNEL).toBe('/security-scan')
  cleanup()
})

it('opens an embedded workbench, retains drafts between mounts, and returns through public navigation', () => {
  const { register, selectPanel, openSession, cleanup } = fixture()
  const surface = register.mock.calls[1]![1]
  const view = surface({})
  expect(view.type).toBe(Workbench)
  const first = view.props
  expect(first.embedded).toBe(true)
  first.draft!.tab = 'settings'
  expect(surface({}).props.draft).toBe(first.draft)
  first.openSession('scan-session')
  expect(openSession).toHaveBeenCalledWith('scan-session')
  first.close()
  expect(selectPanel).toHaveBeenCalledWith(null)
  expect(first.draft).toEqual({})
  cleanup()
})

it('selects the registered main panel for report deep links and removes its listener on disposal', () => {
  const browser = new EventTarget(), document = new EventTarget()
  const id = '12345678-1234-1234-1234-123456789abc'
  vi.stubGlobal('window', browser); vi.stubGlobal('document', document)
  vi.stubGlobal('location', { href: 'http://127.0.0.1:3198/#dsh-security-report=' + id })
  const { register, selectPanel, cleanup } = fixture()
  expect(selectPanel).toHaveBeenCalledWith('security-scan')
  expect(register.mock.calls[1]![1]({}).props.requestedReport).toBe(id)
  cleanup(); selectPanel.mockClear()
  browser.dispatchEvent(new Event('hashchange'))
  expect(selectPanel).not.toHaveBeenCalled()
})

it('accepts only report navigation on the current DSH origin and page', async () => {
  const { reportLinkId } = await import('../src/client/index.js')
  const id = '12345678-1234-1234-1234-123456789abc', base = 'http://127.0.0.1:3198/'
  expect(reportLinkId(base + '#dsh-security-report=' + id, base)).toBe(id)
  expect(reportLinkId('https://example.com/#dsh-security-report=' + id, base)).toBeUndefined()
  expect(reportLinkId(base + 'other/#dsh-security-report=' + id, base)).toBeUndefined()
  expect(reportLinkId(base + '#dsh-security-report=../../private', base)).toBeUndefined()
  expect(reportLinkId('javascript:alert(1)', base)).toBeUndefined()
})
