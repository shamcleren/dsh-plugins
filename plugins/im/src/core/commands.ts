/** Management commands that need an actual Host session. Queries stay available during setup. */
const sessionCommands = new Set(['/status', '/model', '/effort', '/compact'])

export function requiresHostSession(text: string | undefined, administrator: boolean): boolean {
  if (text === undefined) return true
  return administrator && sessionCommands.has(text.trim().split(/\s+/u)[0] ?? '')
}

export function managementHelp(options: { tasks?: boolean; identity?: boolean; sessions?: boolean } = {}): string {
  const sections = [
    ['会话与工作区', [
      ...(options.sessions ? ['/session：查看历史会话', '/session <编号或会话 ID>：切换会话'] : []),
      '/new：新建并切换会话', '/workspace [名称或 ID|reset]：查看或切换工作区',
      '/compact：压缩当前会话',
    ]],
    ['任务与交互', [
      ...(options.tasks ? ['/tasks：查看当前聊天的活动任务', '/cancel [会话 ID]：请求取消任务'] : []),
      '/answer <答案>：回答当前问题', '/approve 或 /reject：允许或拒绝当前审批',
    ]],
    ['模型与预设', [
      '/status：查看模型、推理强度与预设',
      '/model [provider model [effort]]：查看或切换模型',
      '/effort [level]：查看或调整推理强度', '/preset [<id>|reset]：查看或切换预设',
    ]],
    ['帮助', ['/help：查看命令', ...(options.identity ? ['/whoami：查看当前平台身份'] : [])]],
  ] as const
  // Real list markers keep commands separate in clients that fold soft line breaks.
  return sections.map(([title, commands]) => `【${title}】\n\n${commands.map(command => `- ${command}`).join('\n')}`).join('\n\n')
}

/** Never echo a Host exception, message body or credential into an IM response. */
export function managementFailure(): string {
  return '工作台暂时无法完成该操作。发送 /help 查看命令；请在工作台检查当前工作区、模型和 Agent 预设后重试。'
}

export function inboundFailure(phase: 'decode' | 'route', media: boolean): string {
  if (phase === 'route') return '工作台暂时无法接收这条消息。可先发送 /help；请在 IM 管理页检查工作区、模型和连接状态后重试。'
  return media ? '附件未能读取，可能超过大小限制或已失效。请重新发送附件，或先发送纯文本消息。'
    : '这条消息的格式或编号未能识别。请重新发送；若仍失败，请在 IM 管理页检查连接状态。'
}
