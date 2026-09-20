/** Persistent Codex sessions: one DSH session, one resumable Codex thread, native approval. */
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-agent-presets'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-api-session-controller'
import type {} from '@deepseek-ai/dsh-attachment'
import type {} from '@deepseek-ai/dsh-client-connection'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type {} from '@deepseek-ai/dsh-llm'
import type { Session } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-subprocess'
import type {} from '@deepseek-ai/dsh-system-prompt'
import type {} from '@deepseek-ai/dsh-user-approval'
import type {} from '@deepseek-ai/dsh-workspace'
import { AccountQuota } from './account-quota.js'
import { CodexAdapter, CODEX_PROVIDER, NATIVE_MODEL } from './adapter.js'
import { listCodexModels } from './models.js'
import { CodexBridge } from './bridge.js'
import type { CodexSpawn } from './connection.js'
import { emptyRecord, readRecord } from './journal.js'
import { registerDelegate } from './delegate.js'
import { registerHostRpc } from './host-rpc.js'
import { bindBridge } from './owner.js'
import { retireCodexPreset } from './preset-install.js'
import { CODEX_CHANNEL, isSessionId } from './ui-contract.js'

export const name = 'codex-controller'
export const inject = ['tools', 'systemPrompt', 'webServer', 'connection']
export interface Config { journalDirectory?: string }
export const POLICY = 'Use codex_delegate only when the direct human asks to delegate work to Codex. It creates a visible Codex session instead of a hidden worker. Give it a self-contained task and the expected outcome. Follow-up belongs in that Codex session. Codex owns its commands, files, and approvals; do not replay them as DSH tool calls. A DSH approval is one-shot and never grants a session-wide Codex permission.'

export function apply(ctx: Context, config: Config = {}): void {
  if (ctx.webServer.host !== '127.0.0.1') throw new Error('codex-controller requires a loopback Web server')
  const root = config.journalDirectory ?? join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'codex-controller')
  let sessions: { get(id: SessionId): Session | undefined } | undefined
  let agents: { get(id: SessionId): Agent | undefined } | undefined
  let approval: { request(req: { agent: Agent; toolName: string; reason?: string; signal?: AbortSignal }): Promise<'allowed-once' | 'rejected' | 'cancelled' | 'unavailable'> } | undefined
  let controller: Context['sessionController'] | undefined
  let workspaces: { list(): Array<{ path: string }> } | undefined
  let subprocess: Context['subprocess'] | undefined
  let attachments: Context['attachments'] | undefined
  let origin = 'http://127.0.0.1'
  const accountQuota = new AccountQuota(root)
  const spawnCodex = (): CodexSpawn | undefined => {
    const service = subprocess
    if (!service) return
    return spec => service.spawn({ ...spec, stdio: { stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' } })
  }
  const bridge = new CodexBridge({
    root,
    spawn: spec => {
      const spawn = spawnCodex()
      if (!spawn) throw new Error('codex-controller: subprocess service is unavailable')
      return spawn(spec)
    },
    session: id => sessions?.get(id as SessionId),
    agent: id => agents?.get(id as SessionId),
    approve: async (agent, toolName, reason, signal) => approval ? await approval.request({ agent, toolName, reason, signal }) : 'unavailable',
    saveImage: async (data, name) => {
      if (!attachments) throw new Error('图片存储服务不可用')
      return await attachments.saveImage({ data, mediaType: 'image/png', name })
    },
    imageInput: async (attachment, signal) => {
      if (!attachments) throw new Error('图片存储服务不可用')
      const path = attachments.imageHostPath(attachment)
      if (path) return { type: 'localImage', path }
      const stored = await attachments.readImage(attachment, signal)
      const encoded = Buffer.from(stored.data).toString('base64')
      return { type: 'image', url: `data:${stored.ref.mediaType};base64,${encoded}` }
    },
    noteQuota: params => { accountQuota.observe(params) },
  })
  ctx.effect(() => accountQuota.start({
    readLive: signal => bridge.sampleRateLimits(signal),
    spawn: spawnCodex,
  }), 'codex-controller: account quota')
  const cwdFor = (sessionId: string): string | undefined => sessions?.get(sessionId as SessionId)?.header.cwd
  const unbind = bindBridge({ bridge, cwdFor })
  ctx.effect(() => async () => { unbind(); await bridge.close() }, 'codex-controller: bridge')
  ctx.on('session/disposed', session => { void bridge.release(String(session.id)) })
  ctx.inject(['sessions', 'agents'], scope => {
    sessions = scope.sessions
    agents = scope.agents
    scope.effect(() => () => { if (sessions === scope.sessions) sessions = undefined; if (agents === scope.agents) agents = undefined }, 'codex-controller: session lookup')
  })
  ctx.inject(['approval'], scope => {
    approval = scope.approval
    scope.effect(() => () => { if (approval === scope.approval) approval = undefined }, 'codex-controller: approval')
  })
  ctx.inject(['subprocess'], scope => {
    subprocess = scope.subprocess
    accountQuota.kick()
    scope.effect(() => () => { if (subprocess === scope.subprocess) subprocess = undefined }, 'codex-controller: subprocess')
  })
  ctx.inject(['attachments'], scope => {
    attachments = scope.attachments
    scope.effect(() => () => { if (attachments === scope.attachments) attachments = undefined }, 'codex-controller: attachment store')
  })
  ctx.inject(['sessionController', 'agentPresets', 'webServer', 'workspaceRegistry'], scope => {
    controller = scope.sessionController
    workspaces = scope.workspaceRegistry
    origin = 'http://127.0.0.1:' + scope.webServer.port
    const preparation = retireCodexPreset(scope.agentPresets.roots).catch(() => { ctx.logger.warn('Codex preset was left in place; it was not owned by this plugin.') })
    scope.effect(() => () => { if (controller === scope.sessionController) controller = undefined; if (workspaces === scope.workspaceRegistry) workspaces = undefined }, 'codex-controller: session controller')
    void preparation
  })
  ctx.inject(['llm'], scope => {
    if (scope.llm.listProviders().some(provider => provider.id === CODEX_PROVIDER)) return
    const catalog = () => {
      const spawn = subprocess
      return spawn ? listCodexModels(spec => spawn.spawn({ ...spec, stdio: { stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' } })) : Promise.resolve([])
    }
    const handle = scope.llm.registerAdapter([CODEX_PROVIDER], new CodexAdapter(bridge, cwdFor, catalog))
    scope.effect(() => () => handle(), 'codex-controller: adapter')
  })
  ctx.systemPrompt.section({ name: 'tool:codex-controller', order: 117, text: POLICY })
  registerDelegate(ctx, bridge, () => origin, () => controller)
  registerHostRpc(ctx, CODEX_CHANNEL, async (method, payload) => {
    if (method === 'create') return await createSession(payload, controller, bridge, cwdFor, () => workspaces?.list()[0]?.path)
    if (method === 'state') {
      const sessionId = isRecord(payload) ? payload.sessionId : undefined
      if (!isSessionId(sessionId)) return failure('invalid session')
      const record = await readRecord(root, sessionId)
      const quota = accountQuota.snapshot()
      return { ok: true, value: { present: record !== undefined, record: record ?? emptyRecord(sessionId), ...(quota ? { quota } : {}) } }
    }
    return failure('unknown method')
  })
}

async function createSession(payload: unknown, controller: Context['sessionController'] | undefined, bridge: CodexBridge, cwdFor: (sessionId: string) => string | undefined, workspaceCwd: () => string | undefined): Promise<{ ok: true; value: { sessionId: string } } | { ok: false; error: { code: string; message: string } }> {
  if (!controller) return failure('session controller unavailable')
  const requested = isRecord(payload) && typeof payload.cwd === 'string' ? payload.cwd : ''
  const fromSession = isRecord(payload) && isSessionId(payload.sessionId) ? cwdFor(payload.sessionId) : undefined
  const cwd = requested || fromSession || workspaceCwd()
  if (!cwd) return failure('a workspace is required')
  const created = await controller.create({ cwd })
  const sessionId = String(created.sessionId)
  await bridge.remember(sessionId)
  await controller.selectModel({ sessionId: created.sessionId, provider: CODEX_PROVIDER, model: NATIVE_MODEL })
  return { ok: true, value: { sessionId } }
}

function failure(message: string): { ok: false; error: { code: string; message: string } } {
  return { ok: false, error: { code: 'codex-controller', message } }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}
