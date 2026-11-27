# DSH 0.1.6 插件兼容验证

验证日期：2026-09-21，macOS arm64。

运行时锁定官方最新发布 `0.1.6-alpha.2`（npm `alpha`；当日 npm `latest` 为 `0.1.5-rc.2`），应用壳 `0.2.13`。未修改官方源码或已安装官方模块。插件版本和 tarball 身份、大小、SHA-256 以 [marketplace.json](../../marketplace.json) 为准；保留旧版本产物。

## 兼容调整

- 微信、企微机器人、AIDEV、桌宠卡片迁至公开 `plugins.bundle.config` 插槽，以完整包名匹配已安装插件页面。
- 微信、企微和 Codex 会话标记使用当前插槽传入的 `sessionId`，支持多个会话视图；桌面分享通过公开 `uiSession.adapter.current` 获取主会话，并在切换会话时取消附件接收。
- 安全扫描通过公开 `uiWorkspace.openSession` 打开扫描会话；报告版本更新并保留 `0.11.1` 报告读取能力。
- 微信严格 Typert codec 使用 `create()` 提供 schema；Web Search 测试支持新版 MCP `server/discover` 探测及旧协议回退。
- workspace 和独立 runtime 分别锁定依赖；workspace 完整重装后 `pnpm peers check` 无问题。
- 企微办公 Skill bundle 改用受支持的 `insert` 补丁格式，真实 Host 验证 `wecom-unified` Skill 已注册。
- 安装器保留官方 `.dsh-module-fallback`、`.plugin-manager` 元数据及旧 profile；计算链接本身的指纹而不跟随目标。源码链接安装保持原路径，暂存锁文件里的本地包位置转为绝对路径，防止发布后失效；并发改动会阻止覆盖 profile。

## 验证

- 10 个插件 typecheck、build 通过。
- 插件单测：440 通过，2 个已有可选集成测试跳过。
- macOS：25 项通过，包含实际 Swift 编译、WebKit、系统 item provider。
- 安装器：81 项通过，覆盖 profile 事务、旧元数据、外部源码链接和本地包锁文件迁移。
- 已发布 profile 的 manifest 和锁文件复制到不同空目录，使用无凭据 npm 配置执行 `pnpm install --frozen-lockfile --ignore-scripts`，8 个依赖全部重建成功。
- 已构建 App 的隔离内部重启 smoke 连续两轮通过，每轮更换 Host、保持 App 进程并恢复 HTTP 200。夹具以原子写入和持久请求文件状态同步，避免 macOS 目录通知合并造成漏触发。
- `node scripts/smoke-runtime.mjs`：校验并通过官方 CLI 安装全部 10 个最终 tarball 到隔离 `DSH_HOME`；验证精确 peer 兼容、真实 Web 鉴权及安全扫描、市场、Codex 的成功 RPC。AIDEV 启用隔离配置，验证其真实路由的结构化错误响应，不触发远端资源操作。
- smoke 的桌宠关闭原生窗口，Web Search 不访问公共服务；其真实官方 MCP bridge 的工具调用、旧协议回退、取消及卸载由插件测试覆盖。未进行真实微信、企微消息收发或 AIDEV 账号操作。

## MCP 启动边界

发布包实测与上游文档描述存在差异：`!!js` 配置求值抛异常，或 `failOnStartupError: true` 导致激活失败时，官方 loader 仍可在 optional-entry 审计之前抛出，令整个 Host 退出。隔离入口已复现；不能宣称升级已解决所有 MCP 强依赖问题。

当前部署保留缺凭据时条件禁用对应 MCP 的保护，并使用默认 `failOnStartupError: false`。隔离 smoke 同时放入缺凭据的受保护条目和离线 MCP，确认 Host 与鉴权 Web 页面仍返回 HTTP 200。慢连接或等待 OAuth 仍可能延迟 Host 就绪，完整异步启动隔离需要上游修复或新的公开扩展点。

2026-09-21 后续普通启动暴露了部署配置遗漏：此前只保护了 AIDEV 条目，蓝鲸监控与 TAPD 的 `!!js` 仍在环境变量缺失时抛错。已在用户 home 配置中为 10 个监控 MCP 增加 `!process.env.BK_MONITOR_BKAPI_AUTHORIZATION` 禁用条件，为 TAPD 增加 `!process.env.TAPD_ACCESS_TOKEN || !process.env.TAPD_TOOLS_SET`；原配置已备份，凭据表达式与 OAuth 缓存保留。修复属于本机部署配置，不修改官方模块，也不自动改写其他安装的用户配置。经正常 `dhp start` 入口验证，Host 于 06:32:18 UTC 启动、06:32:27 UTC 就绪，原生界面正常恢复。后续验收必须覆盖启动进程缺少全部相关变量的情况，不能用开发终端继承的环境代替。

官方插件页面不等同于专门的 MCP 登录与连接管理中心，也不会替代各服务的 OAuth 凭据缓存。此前的 scope 修正和 mcp-remote 登录缓存应继续保留。

## 当前安装验收

`dist` 已更新为上述运行时与应用壳版本，保留 Share Extension 签名、凭据、用户配置及 profile 备份。8 个已安装插件与 catalog 版本一致，微信继续使用原源码链接；未额外安装 AIDEV 或 Web Search。安装后再次检查全部直接插件的 DSH peer 约束通过。

真实 App 从 Host 启动到就绪约 10 秒。界面已打开侧栏「插件」，显示 8 个已安装插件；微信详情卡片显示 `v0.5.3`、已绑定 1 个账号、消息接收服务运行中。该轮启动未再出现 `email` scope 授权错误。MCP 的上游启动限制仍如上节所述。

## 升级后的市场目录与插件更新

2026-09-21 修复市场目录仍显示 `0.1.5-rc.1` 的问题：已安装的 8 个插件已升级，但旧目录缓存只按来源区分，重启后仍会复用。Marketplace `0.4.3` 将 DSH 版本、profile 路径与已安装包版本纳入缓存身份；变化后首次打开市场自动读取可信仓库，保持原有摘要校验及兼容性判断。

同时修复 `dhp update` 在运行时不变时跳过插件检查的问题。插件独立更新继续使用暂存、校验和事务发布；恢复时额外匹配 profile 更新标识，避免相同运行时版本被误认为更新已提交。

- 市场插件类型检查、构建与 61 项测试通过；安装器 84 项测试通过，覆盖相同运行时更新、无变更重复执行及中断恢复。
- 最终发布包隔离安装通过：10 个目录包身份、摘要与 peers 校验，4 个真实鉴权 RPC，以及缺凭据和离线 MCP 条件下的 Web 就绪。
- 本机通过正常 `dhp update` 将市场 `0.4.2` 更新到 `0.4.3`，再次执行无变更；实际 profile 的官方 DSH peers 校验通过。Host 于 06:43:07 UTC 启动、06:43:14 UTC 就绪。
- 设置 → 内置插件 → 远端市场首次打开自动刷新，显示 10 个目录条目、8 个已安装、0 个可更新；所有目录条目兼容范围均为 `0.1.6-alpha.2`，原有整页不兼容提示消失。
