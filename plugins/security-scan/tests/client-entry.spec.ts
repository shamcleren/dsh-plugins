import { expect, it, vi } from 'vitest'
import { apply } from '../src/client/index.js'
import { SECURITY_CHANNEL } from '../src/ui-contract.js'

it('adds independent sidebar and frame entries without replacing conversation or using settings tabs', () => {
  const dispose: Array<() => void> = [], register = vi.fn(), slots = vi.fn((_slot: string, callback: () => void) => callback())
  const registerLocale = vi.fn(), bind = vi.fn(() => (key: string) => key)
  apply({ effect: callback => { const result = callback(); if (typeof result === 'function') dispose.push(result as () => void) }, locale: { register: registerLocale, bind },
    connection: { rpc: { call: vi.fn() } }, slots: { inject: slots, register } })
  expect(slots.mock.calls.map(call => call[0])).toEqual(['sidebar.footer.action', 'shell.overlay'])
  expect(register.mock.calls.map(call => call[0].id)).toEqual(['security-scan', 'security-scan-workspace'])
  expect(registerLocale).toHaveBeenCalledOnce()
  expect(SECURITY_CHANNEL).toBe('/security-scan')
  for (const cleanup of dispose.reverse()) cleanup()
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
