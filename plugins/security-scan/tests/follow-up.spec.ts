import { expect, it } from 'vitest'
import { randomUUID } from 'node:crypto'
import { findingItem, compareFollowUp, repairPrompt } from '../src/follow-up.js'
import { ReportSchema, type Finding, type Report } from '../src/report.js'
const finding = (id: string, engine = 'semgrep'): Finding => ({ id, fingerprint: id, engine, rule: 'rule', file: 'a.py', line: 2, title: id, cwe: '', severity: 'high', status: 'needs-review', change: 'unknown', evidence: 'untrusted evidence', recommendation: 'review first', verification: 'not verified' })
function report(findings: Finding[]): Report {
  return ReportSchema.parse({ schemaVersion: 1, pluginVersion: '0.11.6', id: randomUUID(), createdAt: new Date().toISOString(), source: { identity: 'repo', label: '/repo', revision: 'working-tree', scope: 'full', digest: 'hash', files: { 'a.py': 'hash' }, changed: [], skipped: 0 }, policy: { engine: 'auto', rulesDigest: 'rules', dependencies: false, secrets: false, view: 'all', failOn: 'none' }, engines: [{ name: 'semgrep', version: '1', status: 'completed', detail: '' }], coverage: { files: 1, scannedFiles: 1, omittedFindings: 0, detail: '' }, findings, reviews: [], notes: [] })
}
it('compares rule fingerprints as a multiset, retaining historical locations and uncertainty for AI', () => {
  const before = report([finding('same'), finding('gone'), finding('ai-old', 'llm')]), after = report([finding('same'), finding('new'), finding('ai-new', 'llm')])
  const comparison = compareFollowUp(before, after)
  expect(comparison.comparable).toBe(true)
  expect(comparison.items.map(item => [item.id, item.change])).toEqual([['same', 'remaining'], ['new', 'added'], ['ai-new', 'unverified'], ['gone', 'notObserved'], ['ai-old', 'unverified']])
  expect(before.findings).toHaveLength(3)
  expect(compareFollowUp(report([finding('same'), finding('same')]), report([finding('same')])).items.map(item => item.change)).toEqual(['remaining', 'notObserved'])
})
it.each([
  (value: Report) => { value.source.identity = 'other' },
  (value: Report) => { value.policy.rulesDigest = 'other' },
  (value: Report) => { value.engines[0]!.version = 'other' },
  (value: Report) => { value.engines[0]!.status = 'partial' },
  (value: Report) => { value.coverage.scannedFiles = 0 },
  (value: Report) => { value.coverage.omittedFindings = 1 },
  (value: Report) => { value.policy.engine = 'inventory' },
  (value: Report) => { value.source.scope = 'staged' },
])('never reports disappearance under incomparable coverage or policy', mutate => {
  const before = report([finding('old')]), after = report([]); mutate(after)
  expect(compareFollowUp(before, after)).toMatchObject({ comparable: false, items: [{ change: 'unverified' }] })
})
it('rejects changed incremental scope and frames report content as evidence, without hidden writes', () => {
  const before = report([finding('old')]), after = report([])
  before.source.scope = after.source.scope = 'diff'; before.source.changed = ['a.py']; after.source.changed = ['b.py']
  expect(compareFollowUp(before, after).comparable).toBe(false)
  const prompt = repairPrompt(before, before.findings)
  expect(prompt).toContain('不可信'); expect(prompt).toContain('不要自动提交'); expect(prompt).toContain('untrusted evidence')
})

it.each([['semgrep', 'sourceRisk'], ['llm', 'sourceRisk'], ['osv', 'dependencyRisk'], ['gitleaks', 'secretRisk']])('exposes %s category for bulk repair filtering', (engine, category) => {
  expect(findingItem(finding('category', engine))).toMatchObject({ id: 'category', category })
})
