/** Shared management command handlers for IM channels (status, model, effort, preset, workspace/session helpers). */
import { randomUUID } from 'node:crypto'
import type { HostApiProxy, HostPreset, HostWorkspace, RpcRequest } from './host-api.js'
import { HostApiError, unwrap } from './host-api.js'

export interface ChannelCommandContext {
  readonly api: HostApiProxy
  readonly rpcPrefix: string
  readonly sessionPrefix: string
  readonly localModelNotice: string
  readonly defaultWorkspace: () => HostWorkspace
  readonly getAgentPreset: () => string | undefined
  readonly setAgentPreset: (next: string | undefined) => void
  readonly writeAgentPreset: (next: string | undefined) => Promise<void>
  readonly createSession: (sessionId: string, workspaceId: string) => Promise<string>
  readonly bindSession: (conversationKey: string, sessionId: string, previousSessionId?: string) => Promise<void>
}

function makeRequest<T>(prefix: string, payload: T): RpcRequest<T> {
  return { rpcId: `${prefix}-${randomUUID()}`, payload }
}

export function selectWorkspace(
  workspaces: readonly HostWorkspace[],
  selector: string,
): HostWorkspace | undefined {
  const byId = workspaces.find(entry => entry.workspaceId === selector)
  if (byId !== undefined) return byId
  const byTitle = workspaces.filter(entry => entry.title === selector)
  return byTitle.length === 1 ? byTitle[0] : undefined
}

export async function listHostWorkspaces(api: HostApiProxy, rpcPrefix: string): Promise<HostWorkspace[]> {
  return unwrap(await api.workspace.list(makeRequest(rpcPrefix, {}))).items
}

export async function workspaceIdForSession(
  api: HostApiProxy,
  rpcPrefix: string,
  sessionId: string,
): Promise<string | undefined> {
  return (await listHostWorkspaces(api, rpcPrefix))
    .find(workspace => workspace.sessionIds.includes(sessionId))?.workspaceId
}

export async function statusCommand(ctx: ChannelCommandContext, sessionId: string): Promise<string> {
  const models = unwrap(await ctx.api.sessions.models(makeRequest(ctx.rpcPrefix, { sessionId })))
  return [
    `当前模型：${models.current.provider} / ${models.current.model}`,
    `Effort：${models.current.reasoningEffort ?? '由模型或提供方决定'}`,
    `预设：${ctx.getAgentPreset() ?? '跟随全局默认'}`,
  ].join('\n')
}

export async function newSessionCommand(
  ctx: ChannelCommandContext,
  conversationKey: string,
  currentSessionId: string,
  replyMessage: string,
): Promise<string> {
  const previousWorkspace = await workspaceIdForSession(ctx.api, ctx.rpcPrefix, currentSessionId)
  const workspaceId = previousWorkspace ?? ctx.defaultWorkspace().workspaceId
  const sessionId = await ctx.createSession(`${ctx.sessionPrefix}-${randomUUID().replaceAll('-', '')}`, workspaceId)
  await ctx.bindSession(conversationKey, sessionId, previousWorkspace === undefined ? undefined : currentSessionId)
  return replyMessage
}

/**
 * Move the channel's agent preset. The channel-local preset lives in its own
 * settings section and takes effect on a rebuilt session instead of leaking
 * into deployment-wide defaults.
 */
export async function presetCommand(
  ctx: ChannelCommandContext,
  conversationKey: string,
  currentSessionId: string,
  args: readonly string[],
): Promise<string> {
  let roster: { items: readonly HostPreset[]; defaultId: string } | undefined
  try {
    roster = unwrap(await ctx.api.presets.list(makeRequest(ctx.rpcPrefix, {})))
  } catch (error: unknown) {
    if (!(error instanceof HostApiError) || error.code !== 'presets-unavailable') throw error
  }
  const current = ctx.getAgentPreset()
  if (args.length === 0) {
    const inherited = roster === undefined ? '全局默认' : `全局默认（${roster.defaultId}）`
    const rows = roster?.items.map(entry => {
      const label = entry.name === undefined ? entry.id : `${entry.id}（${entry.name}）`
      return entry.broken === undefined ? label : `${label} [不可用：${entry.broken}]`
    }) ?? ['（本部署未提供预设列表）']
    return [
      `当前预设：${current ?? `未指定，跟随${inherited}`}`,
      '可选预设：',
      ...rows,
      '',
      '用法：/preset <id> 切换，/preset reset 恢复跟随全局默认。',
    ].join('\n')
  }
  if (args.length !== 1) return '用法：/preset [<id>|reset]'
  const [selector] = args as [string]
  const next = selector === 'reset' ? undefined : selector
  if (next !== undefined && roster !== undefined) {
    const target = roster.items.find(entry => entry.id === next)
    if (target === undefined) return `没有找到预设“${next}”；发送 /preset 查看可选项。`
    if (target.broken !== undefined) return `预设“${next}”当前不可用：${target.broken}`
  }
  if (next === current) {
    return next === undefined ? '当前已经跟随全局默认预设。' : `当前已经在预设“${next}”。`
  }
  try {
    await ctx.writeAgentPreset(next)
  } catch (error: unknown) {
    return `预设未能保存：${error instanceof Error ? error.message : String(error)}`
  }
  ctx.setAgentPreset(next)
  const previousWorkspace = await workspaceIdForSession(ctx.api, ctx.rpcPrefix, currentSessionId)
  const workspaceId = previousWorkspace ?? ctx.defaultWorkspace().workspaceId
  const sessionId = await ctx.createSession(`${ctx.sessionPrefix}-${randomUUID().replaceAll('-', '')}`, workspaceId)
  await ctx.bindSession(conversationKey, sessionId, previousWorkspace === undefined ? undefined : currentSessionId)
  return next === undefined
    ? '已恢复跟随全局默认预设，并创建新会话。旧会话仍保留。'
    : `已切换到预设“${next}”，并创建新会话。旧会话仍保留。`
}

export async function modelCommand(
  ctx: ChannelCommandContext,
  sessionId: string,
  args: readonly string[],
): Promise<string> {
  const models = unwrap(await ctx.api.sessions.models(makeRequest(ctx.rpcPrefix, { sessionId })))
  if (args.length === 0) {
    const rows = models.groups.flatMap(group => group.models.map(model => {
      const efforts = model.reasoning?.efforts.map(effort => effort.id).join(', ')
      return `${group.id} ${model.id}${efforts === undefined ? '' : ` [${efforts}]`}`
    }))
    return [`当前：${models.current.provider} ${models.current.model}`, ...rows].join('\n')
  }
  if (args.length < 2 || args.length > 3) return '用法：/model <provider> <model> [effort]'
  const [provider, model, reasoningEffort] = args as [string, string, string?]
  const group = models.groups.find(entry => entry.id === provider)
  const target = group?.models.find(entry => entry.id === model)
  if (target === undefined) return '没有找到该 provider/model；发送 /model 查看可选项。'
  if (reasoningEffort !== undefined
    && !target.reasoning?.efforts.some(entry => entry.id === reasoningEffort)) {
    return '该模型不支持指定的 effort；发送 /model 查看可选项。'
  }
  const selected = unwrap(await ctx.api.sessions.selectModel(makeRequest(ctx.rpcPrefix, {
    sessionId, provider, model,
    ...reasoningEffort === undefined ? {} : { reasoningEffort },
  }))).selected
  return `已切换到 ${selected.provider} / ${selected.model}，Effort：${selected.reasoningEffort ?? '默认'}。\n${ctx.localModelNotice}`
}

export async function effortCommand(
  ctx: ChannelCommandContext,
  sessionId: string,
  args: readonly string[],
): Promise<string> {
  const models = unwrap(await ctx.api.sessions.models(makeRequest(ctx.rpcPrefix, { sessionId })))
  const group = models.groups.find(entry => entry.id === models.current.provider)
  const model = group?.models.find(entry => entry.id === models.current.model)
  const efforts = model?.reasoning?.efforts ?? []
  if (args.length === 0) {
    return `当前 Effort：${models.current.reasoningEffort ?? '默认'}\n可选：${efforts.map(entry => entry.id).join(', ') || '该模型未公开可调 effort'}`
  }
  if (args.length !== 1) return '用法：/effort <level>'
  const [reasoningEffort] = args
  if (reasoningEffort === undefined || !efforts.some(entry => entry.id === reasoningEffort)) {
    return '该模型不支持指定的 effort；发送 /effort 查看可选项。'
  }
  const selected = unwrap(await ctx.api.sessions.selectModel(makeRequest(ctx.rpcPrefix, {
    sessionId,
    provider: models.current.provider,
    model: models.current.model,
    reasoningEffort,
  }))).selected
  return `Effort 已切换为 ${selected.reasoningEffort ?? reasoningEffort}。\n${ctx.localModelNotice}`
}
