export const zh = {
  tab: 'Git 仓库市场', source: '可信来源', connected: '已连接', disconnected: '未配置（可选）', configure: '来源设置', refresh: '刷新目录',
  optionalSource: 'Git 仓库市场为可选功能。你可以继续使用 DSH 和其他已安装的市场；需要从 Git 仓库安装插件时再打开“来源设置”。',
  installed: '已安装', available: '目录插件', compatible: '兼容', updates: '可更新', search: '搜索名称、包名或描述', all: '全部',
  install: '安装', update: '更新', updateAll: '更新全部', remove: '卸载', removing: '正在卸载…', working: '处理中…',
  installedTag: '已安装', incompatible: '此目录版本不兼容当前 DSH', empty: '没有符合条件的插件。', emptyInstalled: '当前 profile 没有安装目录中的插件。',
  restartPending: '变更已经写入 profile；完成本轮操作后统一重启即可生效。', restartNow: '立即重启', restartSent: '已请求原生 Host 重启。',
  error: '操作失败', retry: '重试', sourceSummary: '单一可信仓库 · 摘要校验 · 安装脚本禁用', repositoryUrl: '仓库地址', sourceHint: '填写 gitlab.example.com 或 github.com 仓库地址。工蜂地址通过 OAuth 连接；GitHub 公开仓库直接读取，不需要授权。',
  oauthLogin: 'OAuth 登录并连接', oauthRelogin: '重新授权', openAuthorization: '打开授权页面',
  oauthConnected: '仓库已连接，插件目录已刷新。', oauthExpired: 'OAuth 授权等待超时，请重试。', save: '保存来源',
  confirmRemove: '确认从当前 Web profile 卸载该插件？', partialUpdate: '部分插件已更新；请检查失败信息后重试。', catalogCount: '目录总数', updateCount: '可更新', installedCount: '已安装',
} as const

export type LocaleKey = keyof typeof zh

export const en: Record<LocaleKey, string> = {
  tab: 'Git repository marketplace', source: 'Trusted source', connected: 'Connected', disconnected: 'Not configured (optional)', configure: 'Source settings', refresh: 'Refresh catalog',
  optionalSource: 'The Git repository marketplace is optional. You can keep using DSH and other installed marketplaces; open Source settings when you want plugins from a Git repository.',
  installed: 'Installed', available: 'Catalog', compatible: 'Compatible', updates: 'Updates', search: 'Search name, package, or description', all: 'All',
  install: 'Install', update: 'Update', updateAll: 'Update all', remove: 'Uninstall', removing: 'Uninstalling…', working: 'Working…',
  installedTag: 'Installed', incompatible: 'This catalog release is incompatible with the current DSH', empty: 'No plugins match the current filters.', emptyInstalled: 'The current profile has no catalog plugins installed.',
  restartPending: 'Changes are saved to the profile; finish this batch and restart once to apply them.', restartNow: 'Restart now', restartSent: 'Native Host restart requested.',
  error: 'Operation failed', retry: 'Retry', sourceSummary: 'Single trusted repository · digest verification · install scripts disabled', repositoryUrl: 'Repository URL', sourceHint: 'Enter a gitlab.example.com or github.com repository URL. Gongfeng uses OAuth. A public GitHub repository is read directly, without authorization.',
  oauthLogin: 'Connect with OAuth', oauthRelogin: 'Authorize again', openAuthorization: 'Open authorization page',
  oauthConnected: 'Repository connected and catalog refreshed.', oauthExpired: 'OAuth authorization timed out; try again.', save: 'Save source',
  confirmRemove: 'Uninstall this plugin from the current Web profile?', partialUpdate: 'Some plugins were updated; review the failure and retry.', catalogCount: 'Catalog', updateCount: 'Updates', installedCount: 'Installed',
}
