import { createRoot } from 'react-dom/client'
import { AgentPanel, BrowserOverlay } from '../../src/client/AgentPanel.js'
import { agentStyles } from '../../src/client/agent-styles.js'
import { importedStyles } from '../../src/client/styles.js'
import { agentZh } from '../../src/agent-locales.js'
import type { AgentState, AgentRemote } from '../../src/agent-contract.js'

// Synthetic UI fixture. No model, account or external website is used here.
let value: AgentState = {
  sessionId: 'ui-review', configured: true, siteName: '服务市场 · 交互验收', phase: 'ready', agentRunning: false,
  operation: '', view: 'table', title: '查询结果', browserReady: true, revision: 1, generation: '00000000-0000-4000-8000-000000000001',
  executionEnabled: true, executionModes: ['debug', 'use'], executions: [],
  listing: { id: '00000000-0000-4000-8000-000000000002', url: 'https://portal.example.test/agents', title: 'Agents', text: '', controls: [], capturedAt: '2026-11-23T08:00:00Z', truncated: false, recordsState: 'ready', records: [
    { id: 'r0', name: '初始化助手', type: '单智能体', version: 'v1.2', description: '检查项目初始化参数。此列表来自本地合成数据，用于交互验证。', tags: ['运维'], actions: [] },
    { id: 'r1', name: '长名称与复杂输入验证助手', type: '工作流', version: 'v2.0', description: '支持多行任务描述，查询结果在读取配置后仍可切回查看。', tags: ['流程'], actions: [] },
  ] },
}
let offline = false, frameOffline = false
const calls: { method: string; payload: any }[] = []
const requests = new EventTarget()
const patch = (next: Partial<AgentState>) => { value = { ...value, ...next, revision: value.revision + 1 } }
const remote: AgentRemote = {
  state: async () => { if (offline) throw new Error('offline'); return structuredClone(value) },
  call: async (method, payload) => {
    calls.push({ method, payload }); const input = payload as Record<string, any>
    if (method === 'view') patch({ view: input.view })
    if (method === 'answer') { patch({ phase: 'queued', question: undefined }); return }
    if (method === 'select') patch({ selected: value.listing!.records.find(row => row.id === input.recordId), selectedId: input.recordId, phase: 'queued' })
    if (method === 'takeover') patch({ phase: 'human', humanReason: 'requested' })
    if (method === 'resume') patch({ phase: 'ready', humanReason: undefined })
  },
  frame: async () => { if (frameOffline) throw new Error('offline'); return new Blob(['<svg xmlns="http://www.w3.org/2000/svg" width="1280" height="900"><rect width="1280" height="900" fill="#f3f6fc"/><text x="60" y="100" fill="#25334b" font-size="32">Original page · synthetic UI fixture</text></svg>'], { type: 'image/svg+xml' }) },
}
Object.assign(window, { reviewUI: { patch, calls, disconnect: (flag: boolean) => { offline = flag }, disconnectFrame: (flag: boolean) => { frameOffline = flag } } })
const style = document.createElement('style'); style.textContent = [...importedStyles, agentStyles].join('\n'); document.head.append(style)
createRoot(document.getElementById('root')!).render(<><AgentPanel sessionId={value.sessionId} remote={remote} t={key => agentZh[key]} openBrowser={() => requests.dispatchEvent(new CustomEvent('open', { detail: value.sessionId }))} /><BrowserOverlay sessionId={value.sessionId} remote={remote} t={key => agentZh[key]} requests={requests} /></>)
