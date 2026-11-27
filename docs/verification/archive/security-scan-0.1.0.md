# Security Scan 0.1.0 验证

日期：2026-09-09。平台：macOS arm64；官方 DSH：`0.1.0-rc.8`；扫描器：Semgrep CE `1.176.1`（临时 Python 3.11 环境）。

## 通过

- Host 类型检查、发布构建及 9 项插件测试，包括真实 DSH 工具注册/调用/卸载、Skill 注册/卸载、工作区越界与符号链接拒绝、环境隔离、进程取消、扫描器缺失/版本不符、覆盖不足和结果脱敏。
- 真实 Semgrep 正反例：Python、Go、JavaScript 夹具命中全部 12 类基础规则；TypeScript 正例命中；安全的 Python/Go/TS 例子未命中。
- 市场 59 项回归测试与插件短命令 12 项测试通过，catalog 新增条目不改变现有市场代码。
- 发布包通过包名、版本、大小、SHA-256 校验；已安装包中的代码实际扫描三语言独立样本，返回预期 3 项 `needs-review`，状态 `completed`，无扫描器错误；缺少扫描器时返回 `scanner-unavailable`。
- 临时 Web profile 同时安装 Marketplace 0.3.0 和 Security Scan 0.1.0，通过真实 `bin/dsh web` 在独立端口启动并返回 HTTP 200；Marketplace 状态接口识别两个已安装版本。`make plugin-list` 正确展示新插件状态，官方 CLI 卸载后恢复为未安装。

## 验证范围

扫描、安装及启动均使用独立临时目录，没有修改用户 profile、配置模型账号、执行项目代码或向模型发送源码。真实 LLM 审计质量尚未通过模型账号验收；本次验证的是规则扫描和 DSH Skill/工具接入。默认自动化测试会跳过真实 Semgrep 用例，需要设置 `SECURITY_TEST_SEMGREP` 才执行它。

市场真实 OAuth、仓库下载及 Host 内安装卸载的前置证据见 [Marketplace 0.3.0 验证](marketplace-oauth-0.3.0.md)。此插件没有集成 OSV、Gitleaks 或商业跨文件扫描，不将其能力计入覆盖。
