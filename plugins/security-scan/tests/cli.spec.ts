import { afterEach, expect, it, vi } from 'vitest'
import { main } from '../src/cli.js'
import * as workflow from '../src/workflow.js'
import { Toolchains } from '../src/toolchains.js'
afterEach(() => vi.restoreAllMocks())
it('keeps managed paths when make or a hook explicitly passes the default engine names', async () => {
  const setup = vi.spyOn(Toolchains.prototype, 'setup').mockResolvedValue({ semgrepPath: '/managed/semgrep', gitleaksPath: '/managed/gitleaks' })
  const audit = vi.spyOn(workflow, 'audit').mockResolvedValue({ json: '/report.json', html: '/report.html', report: { engines: [], coverage: { omittedFindings: 0 }, policy: { failOn: 'none' }, findings: [] } } as unknown as Awaited<ReturnType<typeof workflow.audit>>)
  vi.spyOn(console, 'log').mockImplementation(() => {})
  expect(await main(['scan', '--semgrep', 'semgrep', '--gitleaks', 'gitleaks', '--secrets'])).toBe(0)
  expect(setup).toHaveBeenCalledOnce()
  expect(audit.mock.calls[0]?.[0]).toMatchObject({ semgrepPath: '/managed/semgrep', gitleaksPath: '/managed/gitleaks' })
  await main(['scan', '--semgrep', '/custom/semgrep', '--gitleaks', '/custom/gitleaks', '--secrets'])
  expect(setup).toHaveBeenCalledOnce()
  expect(audit.mock.calls[1]?.[0]).toMatchObject({ semgrepPath: '/custom/semgrep', gitleaksPath: '/custom/gitleaks' })
})

it('rejects the removed evaluation command without preparing tools or advertising it', async () => {
  const resolve = vi.spyOn(Toolchains.prototype, 'resolve')
  const log = vi.spyOn(console, 'log').mockImplementation(() => {})
  expect(await main(['help'])).toBe(0)
  expect(log.mock.calls.flat().join('\n')).not.toContain('evaluate')
  await expect(main(['evaluate'])).rejects.toThrow('Unknown command: evaluate')
  await expect(main(['evaluate', '--runs', '1'])).rejects.toThrow('Unknown or duplicate flag: --runs')
  expect(resolve).not.toHaveBeenCalled()
})

it('treats --dynamic as explicit authorization and rejects URLs that carry credentials', async () => {
  vi.spyOn(Toolchains.prototype, 'setup').mockResolvedValue({ semgrepPath: '/managed/semgrep', gitleaksPath: '/managed/gitleaks' })
  const audit = vi.spyOn(workflow, 'audit').mockResolvedValue({ json: '/report.json', html: '/report.html', report: { engines: [], coverage: { omittedFindings: 0 }, policy: { failOn: 'none' }, findings: [] } } as unknown as Awaited<ReturnType<typeof workflow.audit>>)
  vi.spyOn(console, 'log').mockImplementation(() => {})
  expect(await main(['scan', '--dynamic', 'http://127.0.0.1:3000'])).toBe(0)
  expect(audit.mock.calls[0]?.[0]).toMatchObject({ dynamicUrl: 'http://127.0.0.1:3000/' })
  await main(['scan'])
  expect(audit.mock.calls[1]?.[0]).not.toHaveProperty('dynamicUrl')
  await expect(main(['scan', '--dynamic', 'http://user:secret@127.0.0.1/'])).rejects.toThrow('dynamic-url')
  expect(audit).toHaveBeenCalledTimes(2)
})
