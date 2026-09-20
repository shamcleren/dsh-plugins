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
