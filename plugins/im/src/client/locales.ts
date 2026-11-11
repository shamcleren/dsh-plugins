export const zh = {
  title: 'IM 工作台', intro: '一个入口，连接聊天应用与个人工作区。', platform: '聊天平台', wechat: '个人微信', wecom: '企业微信',
  reception: '消息接收', enabled: '已启用', disabled: '已停用', workspace: '默认工作区', defaultWorkspace: '使用渠道默认工作区',
  state_disabled: '已停用', state_waiting: '等待配置', state_starting: '正在连接', state_running: '运行中', state_failed: '连接异常',
  accountCount: '个账号', capabilities: '渠道能力', commands: '常用命令', commandHint: '先发 /help 查看命令；发 /workspace 查看或切换工作区。',
  switchingHint: '每个平台独立保存账号、工作区和会话。先保存或撤销当前改动，再切换平台。',
  setupHint: '首次使用可直接扫码连接微信，或填写企业微信机器人凭据。新增平台会接入同一个管理入口。',
  enableHint: '启用后接收该平台已授权账号的消息；停用会断开连接，保留账号配置和会话。',
  workspaceHint: '企业微信的工作区改动随下方“保存”一起生效；多机器人模式仅修改当前选中的机器人。',
  cap_text: '文字', cap_image: '图片', cap_file: '文件', cap_video: '视频', cap_approval: '审批', cap_questions: '交互问答', cap_groups: '群聊', cap_notifications: '主动消息',
  saveFailed: '设置未能保存。请刷新后重试，或检查此配置是否允许修改。', statusFailed: '暂时无法读取渠道状态，账号设置仍可查看。',
  workspaceFailed: '无法读取工作区列表，请稍后重试。', missingWorkspace: '原工作区已不可用', loading: '正在读取…', refresh: '刷新状态',
  recentFailure: '最近一次处理异常', 'error_message-format': '入站消息格式或编号无效', error_media: '附件读取失败', error_host: '工作区、模型或会话处理失败', error_connection: '连接失败',
} as const
export type LocaleKey = keyof typeof zh
export const en: Record<LocaleKey, string> = {
  title: 'IM workbench', intro: 'One place for your chats and personal workspaces.', platform: 'Messaging platform', wechat: 'WeChat', wecom: 'WeCom',
  reception: 'Receive messages', enabled: 'Enabled', disabled: 'Disabled', workspace: 'Default workspace', defaultWorkspace: 'Use the channel default',
  state_disabled: 'Disabled', state_waiting: 'Setup needed', state_starting: 'Connecting', state_running: 'Running', state_failed: 'Connection issue',
  accountCount: 'accounts', capabilities: 'Channel capabilities', commands: 'Useful commands', commandHint: 'Send /help for commands; /workspace lists or changes workspaces.',
  switchingHint: 'Accounts, workspaces and sessions stay separate per platform. Save or discard changes before switching.',
  setupHint: 'Scan a QR code for WeChat or enter your WeCom bot credentials. Additional platforms use this same management page.',
  enableHint: 'Receives messages for authorized accounts. Disabling disconnects the platform and keeps configuration and sessions.',
  workspaceHint: 'For WeCom, use Save below to apply workspace changes. With multiple bots, only the selected bot changes.',
  cap_text: 'Text', cap_image: 'Images', cap_file: 'Files', cap_video: 'Video', cap_approval: 'Approvals', cap_questions: 'Questions', cap_groups: 'Group chat', cap_notifications: 'Proactive messages',
  saveFailed: 'Could not save. Refresh and retry, or check whether this setting is writable.', statusFailed: 'Channel status is unavailable. Account settings can still be viewed.',
  workspaceFailed: 'Could not load workspaces. Try again later.', missingWorkspace: 'Workspace unavailable', loading: 'Loading…', refresh: 'Refresh status',
  recentFailure: 'Latest processing issue', 'error_message-format': 'Invalid inbound message format or identity', error_media: 'Attachment could not be read', error_host: 'Workspace, model or session operation failed', error_connection: 'Connection failed',
}
