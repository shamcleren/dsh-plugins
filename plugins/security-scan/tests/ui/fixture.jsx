import React from 'react'
import { createRoot } from 'react-dom/client'
import { Workbench } from '../../src/client/Workbench.tsx'
import { zh } from '../../src/client/locales.ts'
import { newTask } from '../../src/ui-contract.ts'
const taskId = '11111111-1111-4111-8111-111111111111', reportId = '22222222-2222-4222-8222-222222222222'
const config = { ...newTask(), name: '示例服务', target: '/workspace/sample-service' }
const task = { id: taskId, revision: 1, updatedAt: new Date().toISOString(), config }
const run = { id: '33333333-3333-4333-8333-333333333333', taskId, config, status: 'succeeded', phase: 'finished', trigger: 'manual', createdAt: new Date().toISOString(), reportId, findings: 2, coverage: 'complete', resultSummary: { confirmed: 1, pending: 1, dismissed: 0 } }
const state = { tasks: [task], runs: [run], reports: [{ id: reportId, createdAt: run.createdAt, source: config.target, scope: 'full', findings: 2, json: '', html: '' }], settings: { semgrepPath: 'semgrep', gitleaksPath: 'gitleaks', reportDirectory: '/reports', autoScan: false, hookTools: ['edit'] }, settingsWritable: true, warnings: [], agentDefault: null, toolchains: { status: 'ready', phase: 'ready', semgrep: '1.176.1', gitleaks: '8.30.0', error: '' } }
const calls = [], controls = { calls, state, offline: false, saved: 0, closed: false }
window.scanFixture = controls
const findings = [{ id: 'one', category: 'sourceRisk', title: '外部输入直接进入命令执行', file: 'src/api.ts', line: 42, severity: 'high', status: 'confirmed' }, { id: 'two', category: 'dependencyRisk', title: '需要核实的路径访问', file: 'src/files.ts', line: 18, severity: 'medium', status: 'needs-review' }]
findings.push(...Array.from({ length: 24 }, (_, index) => ({ id: 'secret-' + index, category: 'secretRisk', title: '凭据候选 ' + index, file: 'config/example.env', line: index + 1, severity: 'high', status: 'needs-review' })), { ...findings[0], id: 'dismissed', status: 'dismissed' })
const actions = { findings, run, repairable: true, repairMode: 'pr', prPreview: { repositoryUrl: 'https://github.com/example/project', base: 'main', commit: 'a'.repeat(40), revision: 'b'.repeat(64) } }
const remote = {
  state: async () => { if (controls.offline) throw new Error('offline'); return structuredClone(state) },
  models: async () => ({ models: [], partial: false }), setup: async () => {},
  save: async value => { controls.saved++; await new Promise(resolve => setTimeout(resolve, 100)); return { ...task, config: value } },
  run: async () => { calls.push('run'); state.runs.unshift({ ...run, id: crypto.randomUUID(), reportId: undefined, status: 'queued', phase: 'queued' }); return state.runs[0] },
  cancel: async () => {}, settings: async value => { state.settings = value }, hook: async () => {}, remove: async () => {}, removeRun: async () => {}, removeReport: async () => {}, source: async () => ({ content: '42: exec(input)' }),
  report: async () => '<!doctype html><html><body style="font:16px system-ui;padding:24px"><h1>代码安全扫描报告</h1><p>用于 UI 验证的隔离示例，不读取本地仓库或调用模型。</p></body></html>',
  reportActions: async () => structuredClone({ ...actions, ...(controls.prError ? { prError: controls.prError, prPreview: undefined } : {}) }),
  repair: async (id, selected, mode, expectedRevision) => { calls.push({ repair: selected, mode, expectedRevision }); actions.run.repair = { mode, ...(mode === 'pr' ? { workspace: { repositoryUrl: 'https://github.com/example/project', base: 'main', commit: 'a'.repeat(40), branch: 'security/repair-fixture', target: '/fixture/repair', directory: '/fixture/repair', repository: '/workspace/sample-service', sourceIdentity: 'fixture', prUrl: 'https://github.com/example/project/pull/1' } } : {}), admitted: true, sessionId: 'repair-session', requestId: crypto.randomUUID(), findingIds: selected }; return { sessionId: 'repair-session' } },
  rescan: async () => { calls.push('rescan'); const next = { ...run, id: crypto.randomUUID(), reportId: undefined, previousReportId: reportId, status: 'queued', phase: 'queued' }; state.runs.unshift(next); return next },
}
createRoot(document.getElementById('root')).render(<Workbench remote={remote} t={key => zh[key]} close={() => { controls.closed = true }} openSession={id => calls.push({ session: id })} />)
