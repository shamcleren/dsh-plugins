# DSH 代码安全扫描

给 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（DSH）加一个安全扫描工作台：扫描 Python、Go、JavaScript/TypeScript 项目，生成可离线打开的中文报告；选中问题交给 DSH 会话修复，修完再复扫确认。规则扫描在本机运行，不消耗模型 Token；需要更深入的判断时，再让 AI 沿调用链复核。

[English](README.en.md) · [使用手册](docs/guide.md) · [发布记录](https://github.com/shamcleren/dsh-security-scan/releases)

<!-- 演示截图与视频待补充：工作台任务列表、报告与修复面板、复扫对比。 -->

## 能做什么

- **静态扫描，不用模型 Token**：29 条内置 Semgrep 规则，覆盖 Flask、Django、Express、Koa、Next.js、React、Gin、Echo、net/http 和常见 SQL / HTTP 库中的命令注入、SQL 注入、XSS、SSRF、路径穿越、开放跳转、不安全反序列化、关闭 TLS 校验、JWT 不验签等问题。
- **密钥与依赖**：Gitleaks 查找疑似凭据；OSV 查询已知依赖漏洞，支持 npm / pnpm 锁文件、go.sum、requirements 和 uv.lock。
- **只读运行时检查**：对你授权的服务地址发送最多 12 个同源 GET 请求，检查安全响应头、Cookie 属性、CORS、调试页面和 `.git` / `.env` 暴露。
- **AI 复核（可选）**：用 DSH 里已配置的模型读取源码、追踪调用者，确认或排除候选问题，并补充越权、租户隔离等规则难以发现的风险；每条结论都引用实际读过的代码行。
- **修复闭环**：在报告里勾选问题，一键交给 DSH 会话，默认在独立分支里修复并验证；修完自动复扫，对比哪些问题仍然存在，剩下的可以继续下一轮。
- **误报排除**：在报告里标记，或让修复会话核实后经你审批排除；后续扫描自动隐藏，相关代码改动后会重新出现。
- **报告与集成**：离线 HTML、JSON 和 SARIF；每次自动对比同一任务的上一份报告，也可以对比目标分支，只看新增的问题；`dsh-security` CLI、Git hooks 和 CI 复用同一套规则。

## 安装

需要官方 DSH **0.2.1-rc.5**，其他版本尚未验证。

```sh
dsh plugin --profile web add @shamcleren/dsh-security-scan@0.18.0
```

也可以在 DSH 侧栏的「插件 → 添加插件」里填写 `@shamcleren/dsh-security-scan@0.18.0`。命令里写明版本号，是因为 DSH 使用的 pnpm 默认不自动选用发布不到一天的版本；升级时把版本号换成[发布记录](https://github.com/shamcleren/dsh-security-scan/releases)里的新版本。npm 包与 Release 中的 `.tgz` 是同一份文件，也可以直接用 Release 地址安装。官方桌面版把 `web` 换成实际使用的 `desktop` profile。安装后重启 DSH，侧栏上方会出现「安全扫描」。首次启用时，插件会自动下载并校验 Semgrep、Gitleaks 和独立的 Python，放在 `~/.dsh/security-scan/toolchains/`，不改动系统环境。

## 第一次扫描

1. 点击侧栏「安全扫描」，选择「新建任务」。
2. 代码来源选「本地目录」并填写项目路径，或选「仓库地址」填写 Git 地址和分支。只想跑规则、不用模型时，取消「启用 Agentic AI」。
3. 点击「保存并运行」。完成后在「历史报告」中打开报告，勾选要处理的问题，选择「在会话中修复」或「标记为误报」。

也可以在已选择项目的 DSH 会话里直接说：「用安全扫描插件扫描当前项目，并复核候选漏洞」。命令行扫描：

```sh
~/.dsh/profiles/web/node_modules/.bin/dsh-security scan --target /path/to/project
```

## 网络与模型使用

| 检查 | 默认 | 网络 | 模型 Token |
| --- | --- | --- | --- |
| 源码规则 | 开启 | 不联网（首次准备扫描器时需要下载） | 不需要 |
| 密钥检测 | 新任务开启 | 不联网 | 不需要 |
| 依赖漏洞 | 新任务开启 | 向 OSV 发送包名和版本，不发送源码 | 不需要 |
| 运行时检查 | 关闭；填写地址并确认授权后启用 | 只访问你填写的地址 | 不需要 |
| AI 复核 | 新任务开启 | 把选取的源码片段发给你在 DSH 中配置的模型 | 需要 |

CLI 和 Git hooks 不调用模型。插件不收集遥测，也不另存 API Key。报告里包含代码片段和漏洞位置，分享前请按项目的保密要求处理。

## 效果与局限

规则只做函数内分析，不跨函数或文件追踪；缺失授权、越权这类业务问题需要 AI 复核或人工判断。扫描结果是待核实的候选，本次未发现不等于没有漏洞。

真实安装与扫描已在 macOS arm64 上验证。macOS x64 和 Linux（glibc ≥ 2.34）有对应的扫描器发布包，但没有实机验收；Windows 不提供自动准备的扫描器。

## 更多

- [使用手册](docs/guide.md)：扫描范围与基线、报告阅读、AI 审计、修复与复扫、误报排除、Git hooks、CI、扫描器与依赖格式。
- [English guide](docs/guide.en.md) · [贡献指南](CONTRIBUTING.md) · [安全问题反馈](SECURITY.md) · [第三方说明](THIRD_PARTY_NOTICES.md)

MIT 许可。自动下载的扫描器遵循各自的上游许可。
