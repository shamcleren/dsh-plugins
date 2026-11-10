# DSH rc.5 与 IM 渠道验证

2026-10-30，macOS arm64。目标为未修改的官方 `@deepseek-ai/dsh@0.2.1-rc.5`，macOS 应用壳 `0.2.16`。开发 workspace 与部署 runtime 分别锁定依赖；9 个 catalog 插件均发布新版本并精确声明此运行时。

## 对齐来源

- npm `latest` / `next`：DSH `0.2.1-rc.5`，不使用 `alpha`。
- 微信协议参考：Tencent/openclaw-weixin `2.4.10`，快照见微信包第三方声明。
- 企微 Channel 行为参考：核对 npm 正式包 `@wecom/wecom-openclaw-plugin@2026.10.26`；它仍依赖官方 Bot SDK。本仓库接入 DSH 的 WebSocket 渠道，不导入 OpenClaw 宿主接口；HTTP webhook / 企业应用 Agent 模式保持未启用。
- 企微 SDK：`@wecom/aibot-node-sdk@1.0.7`，精确锁定。
- 企微办公 Skill：按第三方声明同步上游快照，保留本地 CLI 路径校验与固定 `@wecom/cli@1.3.4` 预检。本机 CLI 已为 `1.3.4`，未重装。

## 自动验证

- 全部插件 typecheck、build 通过。
- 全部插件回归：505 项通过，2 项条件跳过。跳过项分别要求 `SECURITY_TEST_INSTALLATION` 和 `SECURITY_TEST_SEMGREP`；本次安全扫描发布包加载和工作流另由真实 Host smoke 覆盖，不将其当作真实 Semgrep 扫描验收。
- 安装器、dhp、catalog、导出、回滚与迁移：112 项通过。
- macOS 应用壳：25 项通过。
- 合计 642 项通过、2 项条件跳过。

新增回归覆盖入站文件的 Session 专属 receipt、出站文件/视频、明确交付事件、跨 turn 过滤、字节限制、下载取消、大整数消息 ID、多机器人配置/重复账号拒绝/移除、工作区与模型独立、模型与系统提示词按 step 同步、配置列表并发变动防错写，以及保存失败时保留草稿。

## 真实发布包和升级

`node scripts/smoke-runtime.mjs`：在独立临时 DSH_HOME 中通过官方 CLI 安装全部 catalog tarball，实际启动 rc.5 Host，验证认证 Web 页面、19 个工具和两个 bundled Skills、6 个动态设置表单、revision 冲突、静态字段保护、两个预设、安全扫描工作流、已认证 RPC、无凭据 MCP 拒绝和离线容错，以及市场当前 profile 卸载/重装。

`node scripts/smoke-runtime.mjs --update --previous-runtime=dist/runtime`：用 rc.2 安装与它匹配的旧版发布包和隔离退役插件夹具，经真实 `dhp update` 升级至 rc.5。9 个 catalog 插件更新，退役的 codex-controller 经官方 CLI 移除，原设置和其他依赖保留，再次更新无操作，升级后真实 Host 验证通过。

企微设置界面修复后的 `0.7.0` 完成相关测试、完整安装器/catalog 检查。最终补充请求提交中卸载的异常处理与回归，发布 `0.7.1`，重跑企微 91 项测试、类型检查、构建、catalog 检查，并通过 `--startup-only` 验证最终包的认证 Web 页面与安全 RPC。

## 边界

未向真实微信或企微联系人发送测试消息，未新增账号授权。本次没有声称完成真实账号的文件/视频收发或多机器人并发验收。ID-only 微信引用在没有内联内容时明确显示原消息不可用，不引入 OpenClaw 的 SQLite 引用数据库。语音仅接收平台转写，不提供语音合成；视频进入文件附件，理解能力取决于模型和工具。

## 本机部署

按本次授权通过 `dhp stop` / `dhp update` / `dhp start` 更新原 `dist/` 安装：DSH `0.2.1-rc.5`、App `0.2.16`，已启动 App/Host，受认证保护的本地 Web 入口返回 HTTP 401。`dsh --version` 返回 rc.5；`dhp status` 显示运行时、App、启动器对齐，catalog 无待更新项。

本机已安装的 7 个 catalog 插件全部对齐：微信 `0.5.8`、企微 `0.7.1`、企微办公 `0.2.6`、市场 `0.4.9`、安全扫描 `0.13.2`、桌面分享 `0.1.7`、桌宠 `0.2.6`。原本未安装的 AIDEV 和 Web Search 没有额外启用。

profile 中 `@shamcleren/dsh-codex-controller` 已不存在，原有 `@local/dsh-magpie-auto` 保留。升级前后 `.credentials.yaml`、`profiles/web/cordis.patch.yml`、`settings.yaml.imported` 三份文档的 SHA-256 均一致。旧 profile 由更新器保存在 `~/.dsh/.dhp-backups/`，未导出凭据内容。
