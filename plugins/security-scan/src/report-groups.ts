import type { Finding } from './report.js'
export interface ReportGroup { key: string; title: string; type: string; issues: Finding[][] }
const dependencyName = (item: Finding): string => item.dependency?.name ?? /^(.*)@[^\s]+\s+—/u.exec(item.title)?.[1] ?? item.title
/** Only explicit OSV aliases join advisories; package grouping alone never deduplicates vulnerabilities. */
export function groupFindings(items: Finding[]): ReportGroup[] {
  const groups = new Map<string, ReportGroup>()
  for (const item of items) {
    const type = item.engine === 'osv' ? '依赖漏洞' : item.engine === 'gitleaks' ? '凭据泄漏' : '源码风险'
    const name = item.engine === 'osv' ? dependencyName(item) : item.cwe || item.rule
    const key = type + ':' + (item.dependency?.ecosystem ?? '') + ':' + name
    let group = groups.get(key)
    if (!group) { group = { key, title: name, type, issues: [] }; groups.set(key, group) }
    if (item.engine !== 'osv') { group.issues.push([item]); continue }
    const ids = new Set([item.rule, ...(item.dependency?.aliases ?? [])])
    const matches = group.issues.filter(rows => rows.some(row => [row.rule, ...(row.dependency?.aliases ?? [])].some(id => ids.has(id))))
    group.issues = group.issues.filter(rows => !matches.includes(rows))
    group.issues.push([item, ...matches.flat()])
  }
  return [...groups.values()].sort((a, b) => priority(a.issues.flat()) - priority(b.issues.flat()) || a.type.localeCompare(b.type) || a.title.localeCompare(b.title))
}
export const priority = (items: Finding[]): number => Math.min(...items.map(item => ['confirmed', 'needs-review', 'dismissed'].indexOf(item.status) * 5 + ['critical', 'high', 'medium', 'low', 'info'].indexOf(item.severity)))
