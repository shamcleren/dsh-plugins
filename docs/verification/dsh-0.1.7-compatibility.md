# DSH 0.1.7 兼容性验证

2026-09-28，macOS arm64。锁定官方 `@deepseek-ai/dsh@0.1.7-rc.2`，桌面壳 `0.2.14`，部署验证使用内置 Node `24.19.0`。未修改官方源码或已安装官方模块。发布包身份、大小及 SHA-256 以 [marketplace.json](../../marketplace.json) 为准，旧版本 tarball 保留。

## 迁移范围

- 10 个插件的官方依赖统一锁定到 `0.1.7-rc.2`，Cordis / Schemastery 对齐官方版本。
- 配置从旧 Settings 注册接口迁移至 Profile volatile Config；客户端使用 `configForms.get`。配置变化由所属插件的 `loader/volatile-update` 监听处理。桌宠仅开放 enabled / petId / petSize，静态路径仍拒绝从实时表单修改。
- AIDEV、安全审计使用官方声明式 `dsh-agent-preset`；AIDEV persona 使用 `prefix`。旧预设目录保留，当前插件不再安装或删除这些目录。
- Codex 和安全扫描声明独立消息来源，同时识别官方 V3→V4 迁移产生的 `plugin:` 来源；Codex 支持无持久化 id 的请求输入及 developer 上下文。
- 自定义 RPC 通过官方 Connection admission 校验请求，并传递真实 Peer。
- 更新前备份旧设置；旧默认预设字段在暂存 Profile 中迁移为 `agent-preset-registry.selectedDefault`，随安装事务发布和回滚。Profile 补丁整体替换 config，因此同时保留已有 `default` 回退值，缺失时使用旧默认选择补齐必填值。原 settings.yaml 不在暂存过程中改写；已配置的新字段优先。
- 部署运行时的 pnpm 固定为 `11.28.0`。真实更新复现旧 `11.7.0` 打印 Done 后不退出的问题，进程采样显示遗留空闲 worker；上游已有[对应修复](https://github.com/pnpm/pnpm/pull/13226)，升级后运行时安装和插件更新正常退出，保留原供应链检查与脚本执行限制。开发 workspace 的工具版本独立管理。

Marketplace 后续发布候选已升级至 `0.4.7`；其 74 项测试和宿主适配结果见[宿主适配记录](marketplace-host-profile.md)。下表保留最初运行时迁移时的测试基线。

## 插件检查

| 插件 | 发布版本 | 行为测试 |
| --- | --- | --- |
| AIDEV | 0.3.5 | 37 通过 |
| Codex Controller | 0.3.3 | 29 通过 |
| Desktop Share | 0.1.5 | 15 通过 |
| Desktop Pet | 0.2.4 | 68 通过 |
| Marketplace | 0.4.6 | 70 通过 |
| Security Scan | 0.12.1 | 128 通过，2 条条件测试跳过 |
| Web Search | 0.1.2 | 5 通过 |
| WeChat | 0.5.6 | 60 通过 |
| WeCom AI Bot | 0.6.9 | 72 通过 |
| WeCom Tools | 0.2.3 | 1 通过 |

10 个插件的类型检查、构建通过；行为测试合计 485 通过、2 跳过。安装/发布/迁移测试 106 通过。macOS 25 项检查通过（锁定版本断言更新后单独复验，其余 24 项包含真实 AppKit/WebKit 夹具）。桌面壳已在隔离目录构建，内置 CLI 返回 `0.1.7-rc.2`。

## 官方 Host 发布包验证

使用隔离 `DSH_HOME` 安装全部 10 个 catalog tarball：

- 19 个工具、2 个 bundled Skills 和 Codex 模型 provider 注册成功。
- 4 条插件 RPC 均经过真实浏览器 Cookie/Origin 鉴权。
- 旧 settings.yaml 导入 Profile；6 个实时表单读写、revision 冲突和静态字段拒绝通过。
- AIDEV、安全审计预设均无 activation diagnostic。
- 安全扫描创建真实原生观察会话，生成报告；报告操作和按原配置复扫通过。
- 缺少 MCP 凭据时声明式禁用；离线 MCP 未阻止已鉴权 Web 页面 HTTP 200。
- 用未修改的 0.1.6 生成 V3 会话夹具，再用 0.1.7 执行读/写/再读。两类插件消息及 Codex thread 标记保留，旧 V3 文件字节不变。
- 隔离执行真实 `dhp update`：10 个已安装插件全部保留并升级，原 settings.yaml 字节不变，默认预设迁移成功，再次更新返回 Already up to date。

相关命令：`pnpm --recursive run typecheck`、`pnpm --recursive run build`、`pnpm --recursive run test`、`node --test scripts/tests/*.test.mjs`、`node --test apps/macos/tests/*.test.mjs`、使用 Node 24 执行 `scripts/smoke-runtime.mjs`。

升级回归入口为 `scripts/smoke-runtime.mjs --update --previous-runtime=/path/to/0.1.6/runtime`：先用旧运行时安装旧插件，再调用仓库的 `dhp update`。旧运行时目录只读，不使用版本兼容豁免。

## 验证边界

不使用真实外部账号发送消息、调用付费模型或执行远端写操作。WeChat / WeCom / AIDEV / Codex 外部账号能力依靠组件夹具验证，不能代替真实账号验收。非 macOS 平台、用户自定义预设和未知第三方插件不在此次兼容声明内；不自动迁移用户自定义预设目录。

本记录描述仓库发布候选及隔离验证，不代表已替换用户当前运行的安装。
