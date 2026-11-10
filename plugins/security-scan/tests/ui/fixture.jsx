import React, { useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { Workbench } from '../../src/client/Workbench.tsx'
import { zh } from '../../src/client/locales.ts'
import { newTask } from '../../src/ui-contract.ts'
const taskId = '11111111-1111-4111-8111-111111111111', reportId = '22222222-2222-4222-8222-222222222222'
const config = { ...newTask(), name: '示例服务', target: '/workspace/sample-service', dynamicUrl: 'http://127.0.0.1:3000/', dynamicAuthorized: true }
const task = { id: taskId, revision: 1, updatedAt: new Date().toISOString(), config }
const run = { id: '33333333-3333-4333-8333-333333333333', taskId, config, status: 'succeeded', phase: 'finished', trigger: 'manual', createdAt: new Date().toISOString(), reportId, findings: 2, coverage: 'complete', resultSummary: { confirmed: 1, pending: 1, dismissed: 0 } }
const state = { tasks: [task], runs: [run], reports: [{ id: reportId, createdAt: run.createdAt, source: config.target, scope: 'full', findings: 2, json: '', html: '' }], settings: { semgrepPath: 'semgrep', gitleaksPath: 'gitleaks', reportDirectory: '/reports', autoScan: false, hookTools: ['edit'] }, settingsWritable: true, warnings: [], agentDefault: null, toolchains: { status: 'ready', phase: 'ready', semgrep: '1.176.1', gitleaks: '8.30.0', error: '' } }
const calls = [], controls = { calls, state, offline: false, saved: 0, closed: false }
window.scanFixture = controls
const findings = [{ id: 'one', category: 'sourceRisk', title: '外部输入直接进入命令执行', file: 'src/api.ts', line: 42, severity: 'high', status: 'confirmed' }, { id: 'two', category: 'dependencyRisk', title: '需要核实的路径访问', file: 'src/files.ts', line: 18, severity: 'medium', status: 'needs-review' }]
findings.push(...Array.from({ length: 24 }, (_, index) => ({ id: 'secret-' + index, category: 'secretRisk', title: '凭据候选 ' + index, file: 'config/example.env', line: index + 1, severity: 'high', status: 'needs-review' })), { ...findings[0], id: 'dismissed', status: 'dismissed' })
// The fixture bypasses schema defaults, so every finding states whether it can be excluded.
for (const item of findings) Object.assign(item, { suppressed: false, suppressible: true })
const suppressions = []
// ?chain previews a rescan inside a repair chain: comparison, runtime finding and a follow-up round.
const chain = new URL(location.href).searchParams.has('chain')
const runtime = { id: 'http-csp', category: 'dynamicRisk', title: '页面未设置 Content-Security-Policy', file: 'http://127.0.0.1:3000/', line: 1, severity: 'low', status: 'needs-review', endpoint: 'http://127.0.0.1:3000/' }
if (chain) findings.splice(0, findings.length, findings[0], { ...findings[1], severity: 'high' }, runtime)
const actions = { findings, run: chain ? { ...run, trigger: 'repair', previousReportId: taskId, repairSessionId: 'repair-session' } : run, repairable: true, ...(chain ? { repairChain: { sessionId: 'repair-session', round: 2 }, comparison: { previousId: taskId, comparable: true, items: [{ ...findings[0], change: 'remaining' }, { ...runtime, change: 'added' }, { ...findings[1], id: 'fixed', title: '路径拼接未校验', change: 'notObserved' }] } } : {}), repairMode: 'pr', prPreview: { repositoryUrl: 'https://github.com/example/project', base: 'main', commit: 'a'.repeat(40), revision: 'b'.repeat(64) } }
const remote = {
  state: async () => { if (controls.offline) throw new Error('offline'); return structuredClone(state) },
  models: async () => ({ models: [], partial: false }), setup: async () => {},
  save: async value => { controls.saved++; await new Promise(resolve => setTimeout(resolve, 100)); return { ...task, config: value } },
  run: async () => { calls.push('run'); state.runs.unshift({ ...run, id: crypto.randomUUID(), reportId: undefined, status: 'queued', phase: 'queued' }); return state.runs[0] },
  cancel: async () => {}, settings: async value => { state.settings = value }, hook: async () => {}, remove: async () => {}, removeRun: async () => {}, removeReport: async () => {}, source: async () => ({ content: '42: exec(input)' }),
  report: async () => '<!doctype html><html><body style="font:16px system-ui;padding:24px"><h1>代码安全扫描报告</h1><p>用于 UI 验证的隔离示例，不读取本地仓库或调用模型。</p></body></html>',
  reportActions: async () => structuredClone({ ...actions, ...(controls.prError ? { prError: controls.prError, prPreview: undefined } : {}) }),
  repair: async (id, selected, mode, expectedRevision) => { calls.push({ repair: selected, mode, expectedRevision }); actions.run.repair = { mode, ...(mode === 'pr' ? { workspace: { repositoryUrl: 'https://github.com/example/project', base: 'main', commit: 'a'.repeat(40), branch: 'security/repair-fixture', target: '/fixture/repair', directory: '/fixture/repair', repository: '/workspace/sample-service', sourceIdentity: 'fixture', prUrl: 'https://github.com/example/project/pull/1' } } : {}), admitted: true, sessionId: 'repair-session', requestId: crypto.randomUUID(), findingIds: selected }; return { sessionId: 'repair-session' } },
  continueRepair: async id => { calls.push({ continueRepair: id }); return { sessionId: 'repair-session', count: 2 } },
  suppress: async (id, ids, reason) => {
    calls.push({ suppress: ids, reason })
    for (const key of ids) { const item = findings.find(entry => entry.id === key); item.suppressed = true; suppressions.push({ id: crypto.randomUUID(), sourceIdentity: 'fixture', sourceLabel: config.target, engine: 'semgrep', rule: 'dsh-security.fixture', file: item.file, fingerprint: key, title: item.title, reason, createdAt: new Date().toISOString(), findingId: key }) }
    return { added: ids.length, existing: 0 }
  },
  suppressions: async () => structuredClone(suppressions),
  unsuppress: async id => {
    calls.push({ unsuppress: id })
    const index = suppressions.findIndex(item => item.id === id)
    if (index < 0) throw new Error('suppression-not-found')
    findings.find(item => item.id === suppressions[index].findingId).suppressed = false
    suppressions.splice(index, 1)
  },
  rescan: async () => { calls.push('rescan'); const next = { ...run, id: crypto.randomUUID(), reportId: undefined, previousReportId: reportId, status: 'queued', phase: 'queued' }; state.runs.unshift(next); return next },
}
function NavigationFixture() {
  const [selected, select] = useState(true)
  const draft = useRef({}).current
  return <div style={{ display: 'flex', height: '100vh' }}>
    <aside style={{ width: 180, flexShrink: 0 }}><button onClick={() => select(true)}>安全扫描面板</button><button onClick={() => select(false)}>其他插件面板</button></aside>
    <section style={{ flex: 1, minWidth: 0, minHeight: 0 }}>{selected
      ? <Workbench remote={remote} t={key => zh[key]} embedded draft={draft} close={() => { Object.keys(draft).forEach(key => delete draft[key]); select(false) }} openSession={id => calls.push({ session: id })} />
      : <h1>其他插件</h1>}</section>
  </div>
}
createRoot(document.getElementById('root')).render(new URL(location.href).searchParams.has('navigation') ? <NavigationFixture /> : <Workbench remote={remote} t={key => zh[key]} close={() => { controls.closed = true }} openSession={id => calls.push({ session: id })} />)
