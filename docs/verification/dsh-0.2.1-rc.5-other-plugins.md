# DSH rc.5 其他插件兼容验收

2026-10-30，macOS arm64，未修改的官方 DSH `0.2.1-rc.5`、应用壳 `0.2.16`、App 内嵌 Node `24.19.0`。本轮继续验证 IM 之外的插件；真实微信/企微收发和第二机器人配置由用户自行验收。

## 发现与修复

市场 `0.4.9` 的 Host 组件运行正常，但实际插件详情页没有市场面板：前端注册到旧 `settings.plugins.tab`，新版插件管理页使用 `plugins.bundle.config`。修复版 `0.4.10` 使用按包名绑定的公开配置插槽，改用官方 Cordis、UI 插槽和连接服务类型。回归测试只挂载当前插槽，确保注册出的页面确实可渲染。

旧 `smoke-runtime.mjs --desktop-app` 只识别官方 Electron 布局，无法验证当前原生 macOS 壳。新增目标解析：原生壳使用其内嵌 Node/runtime 和独立 Web profile；官方 Electron 仍使用 Desktop Host/profile。缺少内嵌 Node 或未知布局在安装前报错，不回退到开发 runtime。4 项目标解析回归通过。

## 验证结果

| 插件 | 本轮证据 | 验证范围与限制 |
| --- | --- | --- |
| 安全扫描 `0.13.2` | 实际安装的 Semgrep 执行隔离 Python/Go/JS/TS 夹具，9 项通过；真实 Host 的扫描、原生观察会话、报告操作和原配置重扫通过；本机工作台可打开 | 不扫描用户项目，不把隔离扫描视为业务项目安全结论 |
| 市场 `0.4.10` | 类型检查、75 项测试、构建通过；最终 tarball 真实安装启动和认证 RPC 通过；本机详情页显示可信来源、目录/已安装标签、刷新和来源设置 | 实际刷新目录失败；使用现有访问令牌对固定工蜂 API 的只读诊断返回 HTTP 401，需重新授权后复验真实远端目录；未更换来源或录入凭据 |
| 桌宠 `0.2.6` | 68 项测试通过；本机配置页显示已安装资源、选择项及控制项，组件运行 | 用户的桌宠显示开关关闭，未代为开启，不声称浮窗已验收 |
| 桌面分享 `0.1.7` | 15 项插件测试通过；macOS 原生测试包含真实系统 item provider 的原文件名和字节传输、收件箱隔离与桥接安全 | 未使用真实 IM 消息完成分享全流程 |
| 企微办公 `0.2.6` | Skill 包校验通过；真实 Host 注册 bundled Skills；本机 CLI 为固定的 `1.3.4` | 未进行文档、邮件、会议等真实写入 |
| AIDEV `0.3.7` | 37 项测试通过；隔离真实 Host 注册工具、配置表单和认证 RPC，缺失凭据保护、离线 MCP 容错通过 | 本机原本未安装，未额外启用，未验收真实 AIDEV 后端业务 |
| Web Search `0.1.4` | 5 项测试通过；真实 MCP 搜索/抓取工具注册、调用及卸载清理可执行 | 两个真实调用均被 Exa 免费 MCP 配额拦截，未获得成功搜索或抓取结果；未增加付费密钥 |

六个非 IM、非安全扫描包的定向测试共 201 项通过（含上表市场 75 项，不重复计数）。安装器与工程脚本 116 项、macOS 原生 25 项通过；最终发布包的 catalog 合约与目标解析 5 项通过。上述为不同范围的检查，不与上一轮 IM 报告的总数相加。

最终包再次执行：

```sh
node --test scripts/tests/catalog-compatibility.test.mjs scripts/tests/smoke-target.test.mjs
node scripts/smoke-runtime.mjs '--desktop-app=dist/DeepSeek Harness.app'
```

第二条命令在临时 DSH_HOME 中通过官方 CLI 安装全部 9 个 catalog tarball，实际运行 App 内嵌 Node 与官方 Host：19 个工具、2 个 bundled Skills、6 个动态表单、revision 冲突、静态字段保护、2 个预设、认证 RPC、安全扫描工作流、无凭据拒绝、离线容错及市场当前 profile 卸载/重装通过。此 smoke 不自动操作原生窗口；市场、桌宠和扫描工作台的界面另在本机 App 中检查。

## 本机交付

通过正常 `dhp stop` / `dhp update` / `dhp start` 安装市场 `0.4.10` 的新 catalog 发布包，未修改已安装副本。更新器保留旧 profile，比较备份与现 profile 的 `cordis.patch.yml`，字节一致。未新增 AIDEV/Web Search 安装，未调整机器人、工作区、模型或桌宠开关。

更新后的 App/Host 已启动；安装插件的 DSH 兼容约束检查通过。`dhp status` 显示运行时、App、启动器对齐，catalog 无待更新版本。远端市场授权和 Exa 配额限制保留为未完成的真实服务验收项。

后续用户配置双机器人后的默认模型故障与 `0.7.2` 修复见 [企微默认模型验证](wecom-0.7.2-default-model.md)。
