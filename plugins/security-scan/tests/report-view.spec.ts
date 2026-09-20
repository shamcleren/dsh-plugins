import { expect, it } from 'vitest'
import { groupFindings, linkText } from '../src/report-view.js'
import type { Finding } from '../src/report.js'
function dependency(id: string, aliases: string[] = [], file = 'requirements.txt'): Finding {
  return { id, rule: id, fingerprint: id, engine: 'osv', file, line: 4, title: 'mistune@3.1.4 — ' + id, cwe: '', severity: 'medium', status: 'needs-review', change: 'unknown', evidence: '', recommendation: '', verification: '', dependency: { name: 'mistune', version: '3.1.4', ecosystem: 'PyPI', advisoryId: id, aliases, fixedVersions: [], summary: '', references: [], metadataAvailable: true, locationExact: true } }
}
it('groups packages and merges only proven advisory aliases across manifest occurrences', () => {
  const findings = [dependency('GHSA-A', ['CVE-A']), dependency('PYSEC-A', ['CVE-A']), dependency('GHSA-B'), dependency('GHSA-A', [], 'sub/requirements.txt')]
  const groups = groupFindings(findings)
  expect(groups).toHaveLength(1)
  expect(groups[0]!.issues).toHaveLength(2)
  expect(groups[0]!.issues.flat()).toHaveLength(4)
  expect(groups[0]!.issues.some(rows => rows.length === 3)).toBe(true)
  expect(findings).toHaveLength(4)
})
it('links HTTP references while escaping markup, credentials and trailing punctuation', () => {
  const html = linkText('<img src=x onerror=alert(1)> https://osv.dev/vulnerability/GHSA-A。 javascript:alert(1) https://user:pass@example.com/path')
  expect(html).toContain('href="https://osv.dev/vulnerability/GHSA-A"')
  expect(html).toContain('&lt;img')
  expect(html).not.toContain('href="javascript:')
  expect(html).not.toContain('href="https://user:pass')
  expect(html).toContain('rel="noopener noreferrer"')
})

it('summarizes actions by category without equating dependency records to confirmed vulnerabilities', async () => {
  const { reportSummary, renderSummary } = await import('../src/report-summary.js')
  const report = { findings: [dependency('GHSA-A', ['CVE-A']), dependency('PYSEC-A', ['CVE-A']), { ...dependency('tls'), engine: 'semgrep', cwe: 'CWE-295', status: 'confirmed' }, { ...dependency('secret'), engine: 'gitleaks', status: 'dismissed', evidence: 'Only [REDACTED] was seen' }] } as unknown as import('../src/report.js').Report
  const summary = reportSummary(report)
  expect(summary.sourceConfirmed).toHaveLength(1)
  expect(summary.packages).toHaveLength(1)
  expect(summary.packages[0]!.issues).toHaveLength(1)
  expect(summary.recheck).toHaveLength(1)
  const html = renderSummary(report, (file, line) => file + ':' + line)
  expect(html).toContain('未校验 HTTPS 服务器证书')
  expect(html).toContain('历史“已排除”结论需要复查')
  expect(html).toContain('2 条数据库记录')
})

it('renders a summary-first page with valid interactive script and retains nonempty alias summaries', async () => {
  const { renderReport } = await import('../src/report.js')
  const { Script } = await import('node:vm')
  const report: import('../src/report.js').Report = { schemaVersion: 1, pluginVersion: '0.8.1', id: '12345678-1234-4234-8234-123456789abc', createdAt: '2026-09-10T00:00:00.000Z', source: { identity: 'test', label: '/repo', revision: 'working-tree', scope: 'full', digest: 'test', files: { 'requirements.txt': 'hash' }, changed: [], skipped: 0 }, policy: { engine: 'auto', rulesDigest: 'test', dependencies: true, secrets: false, view: 'all', failOn: 'none' }, engines: [], coverage: { files: 0, scannedFiles: 0, omittedFindings: 0, detail: '' }, findings: [dependency('GHSA-A', ['CVE-A']), dependency('PYSEC-A', ['CVE-A'])], reviews: [], notes: [] }
  report.findings[0]!.dependency!.summary = 'Available human-readable advisory title'
  const html = renderReport(report)
  expect(html.indexOf('先看这几件事')).toBeLessThan(html.indexOf('原始发现与证据'))
  expect(html).toContain('Available human-readable advisory title')
  expect(html).toContain('value="active" selected')
  expect(() => new Script(html.split('<script>')[1]!.split('</script>')[0]!)).not.toThrow()
})

it('lists AI model and compact usage from the saved report, and formats cache hit from input-side tokens', async () => {
  const { writeReport, listReports, renderReport } = await import('../src/report.js')
  const { formatAgentUsage, formatTokenCount } = await import('../src/agent-contract.js')
  const { mkdtemp, rm } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  expect(formatTokenCount(24_100_000)).toBe('24.1M')
  expect(formatAgentUsage({ usageAvailable: true, inputTokens: 24_100_000, outputTokens: 0, cacheReadTokens: 23_618_000 }, '缓存命中')).toBe('24.1M tok · 缓存命中 98%')
  expect(formatAgentUsage({ usageAvailable: false, inputTokens: 10, outputTokens: 10, cacheReadTokens: 9 }, '缓存命中')).toBeUndefined()
  const root = await mkdtemp(join(tmpdir(), 'dsh-security-reports-'))
  try {
    const report: import('../src/report.js').Report = {
      schemaVersion: 1, pluginVersion: '0.11.1', id: '12345678-1234-4234-8234-123456789abc', createdAt: '2026-09-11T00:00:00.000Z',
      source: { identity: 'test', label: '/repo', revision: 'working-tree', scope: 'full', digest: 'test', files: { 'app.py': 'hash' }, changed: [], skipped: 0 },
      policy: { engine: 'auto', rulesDigest: 'test', dependencies: false, secrets: false, view: 'all', failOn: 'none' },
      engines: [], coverage: { files: 0, scannedFiles: 0, omittedFindings: 0, detail: '' }, findings: [], reviews: [], notes: [],
      agent: { status: 'completed', reason: 'completed', provider: 'deepseek', model: 'deepseek-chat', steps: 1, areas: [], files: [], reviewedFindings: 0, additionalFindings: 0, inputTokens: 24_100_000, outputTokens: 12_000, cacheReadTokens: 23_618_000, cacheWriteTokens: 0, usageAvailable: true, events: [] },
    }
    await writeReport(root, report)
    expect(await listReports(root)).toMatchObject([{ source: '/repo', findings: 0, agent: { model: 'deepseek/deepseek-chat', usageAvailable: true, inputTokens: 24_100_000, outputTokens: 12_000, cacheReadTokens: 23_618_000 } }])
    expect(renderReport(report)).toContain('24.1M tok · 缓存命中 98%')
  } finally { await rm(root, { recursive: true, force: true }) }
})

it('masks credential-hit files completely and refuses mismatched evidence digests', async () => {
  const { addExcerpt, mergeArchives } = await import('../src/report-evidence.js')
  const report = { source: { files: { 'config.py': 'digest' } }, findings: [{ engine: 'gitleaks', file: 'config.py' }] } as unknown as import('../src/report.js').Report
  const archive = { snippets: [], omitted: 0 } as import('../src/report-evidence.js').EvidenceArchive
  addExcerpt(archive, report, 'config.py', 12, ['unknown_credential_format = "never-export-this"'])
  expect(JSON.stringify(archive)).not.toContain('never-export-this')
  expect(archive.snippets[0]).toMatchObject({ start: 12, sourceHash: 'digest', redacted: true })
  archive.snippets[0]!.sourceHash = 'different'
  expect(() => mergeArchives(report, archive)).toThrow('digest')
})
