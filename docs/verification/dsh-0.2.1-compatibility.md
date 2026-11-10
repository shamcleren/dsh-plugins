# DSH 0.2.1 升级评估与兼容验证

2026-10-19，macOS arm64。目标为未修改的官方 `@deepseek-ai/dsh@0.2.1-rc.2` npm 发行包，应用壳 `0.2.15`，应用内 Node `24.19.0`。本记录覆盖仓库发布候选的隔离验证；用户随后授权的本机部署结果见末节。

## 升级结论

建议从仓库桌面版 `0.1.7-rc.2` 升级至经过本次验证的 `0.2.1-rc.2`。官方 npm `latest` 与 `next` 均指向该版本，但它仍是候选版本，不扩大兼容声明到未来版本。

升级前本机另有 `/opt/homebrew/bin/dsh`，返回 `0.1.0-rc.7`；它与仓库 `dist/` 中的桌面运行时独立。直接执行全局 `dsh` 不能代表桌面版版本，`dhp update` 也不管理该全局安装。

[官方 0.2.1-rc.2 发布记录](https://github.com/deepseek-ai/deepseek-harness/releases/tag/dsh-v0.2.1-rc.2)新增 V4.1-Flash-1017 与 Search/Fetch API 适配。[0.2.1-rc.1 发布记录](https://github.com/deepseek-ai/deepseek-harness/releases/tag/dsh-v0.2.1-rc.1)包含插件依赖同步、会话恢复、任务状态与资源清理修复。这些改进对本仓库的插件和长任务使用有价值。

## 适配范围

- 10 个插件的官方依赖、catalog 和 `engines.dsh` 精确对齐 `0.2.1-rc.2`；Cordis、Schemastery、Loader 与官方依赖对齐。开发 workspace 和部署 runtime 继续独立锁定。
- 移除市场已失去上游运行时支持的 invariant companion；Desktop Share 的 Slots 仅作类型依赖，保留于开发依赖，不要求宿主提供独立运行时包。
- 配置表单测试移除旧 `mode` 字段；微信测试明确加载 Gateway 的 browser export；原生 Bash 测试提供新版 workingDirectory 能力；会话迁移测试使用 JSONL backend 的具名插件导出和显式注入。
- 更新器在替换安装前检查第三方插件的 `engines.dsh`，同时保留原有 peer 检查。新增仅声明 engines 的兼容、拒绝和非法输入回归。
- 桌宠进程测试等待子进程就绪信号后验证优雅关闭，避免机器负载影响固定关闭时限；未放宽生产关闭时限或断言。
- 所有插件均生成新的 catalog 发布包，旧 tarball 保留；身份、大小和 SHA-256 以 [marketplace.json](../../marketplace.json) 为准。

## 市场更新限制与选择

官方 `PluginManager.installBundle` 在存在 HMR 时拒绝覆盖已安装包，公开服务没有通用更新方法。经用户确认，本仓库保留该保护：市场展示中英双语“升级说明”，后端返回 `update-offline`，保留现有包、manifest 和 lockfile；不会通过先卸载来规避限制。

本仓库受管安装退出 DSH 后执行 `dhp update`，再重新打开；自定义安装目录使用相同的 `--dir`。其他安装方式按其说明升级。新插件安装、目录刷新与卸载继续通过官方管理接口执行。

## 插件验证

| 插件 | 新发布版本 | 行为测试 |
| --- | --- | --- |
| AIDEV | 0.3.6 | 37 通过 |
| Codex Controller | 0.3.4 | 29 通过 |
| Desktop Share | 0.1.6 | 15 通过 |
| Desktop Pet | 0.2.5 | 68 通过 |
| Marketplace | 0.4.8 | 75 通过 |
| Security Scan | 0.13.1 | 143 通过，2 条条件测试跳过 |
| Web Search | 0.1.3 | 5 通过 |
| WeChat | 0.5.7 | 60 通过 |
| WeCom AI Bot | 0.6.11 | 74 通过 |
| WeCom Tools | 0.2.4 | 1 通过 |

合计 507 项插件测试通过、2 项跳过；安装、发布与迁移测试 111 项通过；macOS 25 项检查通过。全部组件的类型检查和构建通过。市场新增后端保护和 RPC 状态回归；catalog 测试核对发布包的 engines、依赖、公开导出及完整性。

## 真实入口与升级验证

使用隔离 HOME/DSH_HOME，无真实账号、模型调用或外部写操作：

- 官方 Host 安装全部 10 个 catalog tarball，注册 20 个工具、2 个 bundled Skill 和 Codex provider。
- 验证已鉴权 Web 页面、4 个插件 RPC、6 个实时配置表单、revision 冲突、静态字段拒绝和 2 个预设。
- 安全扫描创建真实原生观察会话、生成报告、读取报告操作并按原配置复扫；inventory 结果不认定为漏洞修复证明。
- 验证缺失 MCP 凭据的禁用和离线 MCP 的启动容错。
- 用真实旧 `0.1.7-rc.2` 运行时安装旧版 10 个插件，再执行真实 `dhp update`：全部保留并升级，settings.yaml 字节不变，默认预设迁移成功，再次更新为 no-op。
- 官方 JSONL provider 读、写、再读旧 V3 会话，插件消息和 Codex thread 标记保留，旧文件字节不变。
- 隔离构建 macOS App，签名验证、Info.plist 校验及内置 CLI `--version` 通过；使用构建后 App 内 Node 24 和 runtime 安装全部插件，已鉴权页面及安全扫描 RPC 启动验证通过。
- 最终包的市场卸载、重装和重新激活通过；已安装包的升级请求被明确拒绝，profile manifest 与 lockfile 字节不变。每次依赖变更后通过新 HTTP 请求读取已激活服务，避免测试保留已被 HMR 替换的旧服务实例。

主要入口为根目录 `typecheck` / `test` 与各插件的 `build`，`node --test apps/macos/tests/*.test.mjs`，以及使用应用内 Node 24 执行 `scripts/smoke-runtime.mjs runtime --update --previous-runtime=/path/to/0.1.7/runtime`。本次依赖验证使用临时包缓存；调用 pnpm 脚本时显式设置 `--config.verify-deps-before-run=false` 以避免机器的自动安装检查因缓存路径不同重建 node_modules；冻结锁文件、安装脚本限制、类型检查和测试断言均保留。

## 验证边界

微信扫码收发、企微回调、AIDEV 私有资源、Codex 真实账号任务、模型费用和远端写操作未做真实账号验收；使用组件夹具与无账号 Host 验证。未做完整浏览器交互巡检；Web 页面 HTTP 与宿主 RPC 验证不替代浏览器功能验收。未验证其他平台、未知第三方插件或用户自定义预设；隔离 App 使用本机临时签名，未验收生产 Share Extension 签名分发。

## 用户授权后的本机部署

2026-10-19，用户确认升级桌面版并只保留桌面版使用方式后：

- 通过 `dhp stop` 停止该受管安装，再用 `dhp update` 完成事务升级。DSH 为 `0.2.1-rc.2`，App 为 `0.2.15`，原有 8 个已安装 catalog 插件全部对齐新发布包；未额外安装原先未启用的插件。
- 保留原安装的分享扩展签名设置，App、Share Extension 和内置 Node 均完成构建与签名校验。数据目录仍为原 `~/.dsh`，更新事务已结束且无残留事务锁。
- 通过 `dhp start` 重新打开桌面版。真实 Host 日志记录就绪，本地页面无凭据访问返回预期的 HTTP 401，未检出启动失败或模块缺失；`dhp status` 显示运行时、App、启动器对齐且无待更新插件。App 内置 CLI 和受管 CLI 均返回 `0.2.1-rc.2`。未从日志获取登录凭据；原生壳按设计将令牌脱敏。
- 确认旧全局 DSH 无活动进程后，用 npm 对 `/opt/homebrew` 前缀执行 `uninstall --global --ignore-scripts @deepseek-ai/dsh`。旧 `0.1.0-rc.7` 包及 `/opt/homebrew/bin/dsh` 链接已移除，`dhp` 继续保留；未删除用户数据或桌面版内置运行时。

本节不增加真实账号发送消息、模型调用或完整浏览器交互验收的声明。

## 提交前复核

基线为 `ca2af7966c5b24d7237fd3166e2d44312e81cde4`，审查对象为本记录所在提交的工作区变更。允许的变化是锁定新运行时、发布兼容插件，以及用户已同意的市场离线升级指引；插件安装、卸载、配置保留、鉴权和失败恢复必须保持。未发现必须在提交前修复的功能问题。

| 复核项 | 证据与结论 |
| --- | --- |
| 功能非预期退化 | 已验证范围通过。逐项核对 10 个 manifest 的依赖变更，没有无关的非 DeepSeek 直接依赖升级；发布包 contract 和摘要检查通过。隔离真实 Host、旧版本升级和本机部署证据见上文。真实账号与完整浏览器交互仍属未验证范围。 |
| 性能机制 | 通过机制检查。新增 engines 检查对声明该字段的直接插件增加一次本地运行时 manifest 读取，工作量随直接插件数线性增长，不新增网络或模型调用；市场升级指引不触发安装调用。没有项目耗时预算，本次未做吞吐或尾延迟基准。 |
| engines 分支 | 重跑 home/catalog 21 项测试通过。原生 Node V8 覆盖中 verifyProfilePeers 执行 22 次，覆盖 engines 缺失、匹配、不匹配、非字符串与非法范围；整个 home-compatibility 模块的分支覆盖率为 73.06%，不能当作新增分支覆盖率。运行时非法版本由既有 releaseInfo 校验拒绝，不作为有效发行输入。 |
| 市场安装与升级拒绝 | service/RPC 15 项定向测试通过，覆盖首次安装、已安装包拒绝且不卸载、Web/Desktop profile、安装取消和明确 RPC 错误状态。真实包验证另覆盖更新拒绝前后 manifest/lockfile 字节不变。 |
| UI 分支覆盖 | 证据不足。按钮转为升级说明及本地化错误展示已通过类型检查和人工代码核查，未新增组件交互单测，也未以 Host RPC 成功冒充浏览器交互覆盖。此限制不影响已有后端拒绝与数据保留证据。 |
| 复验与提交范围 | 定向测试、全组件类型检查、git diff 检查通过；复用同一工作区已完成的 507 项插件、111 项安装迁移、25 项 macOS 验证，2 项条件跳过仍保留。提交包含新 tarball、catalog、锁文件、源码、测试和文档，不包含 dist、依赖目录、缓存、临时账号数据或凭据。 |

V8 环境变量未采集到 Vitest 转换后的 service/RPC 源码，因此只保留这两组的有效行为断言，不宣称其分支覆盖率。功能检查通过限于上述证据范围，不代表全部真实账号与界面流程均已验收。
