# Security Scan 0.2.0 验证

日期：2026-09-10；macOS arm64；官方 DSH `0.1.0-rc.8`。扫描器：Semgrep CE `1.176.1`、Gitleaks `8.24.2`；依赖数据库：官方 OSV querybatch v1。

## 通过

- 插件类型检查、构建及 22 项测试通过（配置真实 Semgrep 和临时 DSH 安装时无跳过）。覆盖公共工具注册/卸载、精确证据读取、复核新版本、补充发现、暂存区隔离、Git 基线、完全重命名、行号移动、基线不可比、扫描失败、脱敏、HTML 转义、只移除自有 hook、后台队列取消等。
- 工程脚本 45 项测试通过，包括新 `make scan` 在没有全局 Node 时使用安装器的私有 Node，保留带空格和引号的路径，读取安装记录中的数据目录，以及已有安装器/插件管理回归。
- 实际 Semgrep 对 Python、Go、JS/TS 正反例验证通过；发布包的增量扫描将历史 shell 调用与新增 eval 区分，语句前缀和行号变化不制造重复告警。
- 实际 Gitleaks 扫描合成 `.env` 中的测试 Token，返回脱敏候选；实际 OSV 查询公开的 `Django==2.0.0` 依赖，漏洞记录进入同一 JSON/HTML 报告。没有使用或验证真实凭据。
- 通过 SSH 地址临时裸克隆本仓库远端 `main`，完成范围盘点；证据读取入口再次按记录的提交获取 README 指定行。没有 checkout、更新工作树、执行项目代码或修改远端。
- 真实 pre-commit hook 读取 index 中的风险代码，忽略工作树中的未暂存安全改动；真实 pre-push hook 读取 Git 标准输入中的实际推送提交，忽略暂存区及工作树改动。未执行真实 Git push。
- 浏览器验证 HTML 概览、风险/历史状态筛选和证据展开，截图检查布局；页面无外部资源。离线示例见 [HTML](../examples/security-report/report.html) 和对应 [JSON](../examples/security-report/report.json)。
- 最终 tarball 经包名、版本、大小和 SHA-256 校验，通过 `make plugin-install` 安装到独立 profile；`make scan` 运行该已安装发布包并生成报告。
- 官方 `--dump-config` 验证发布包参与 profile 合成。真实 Web Host 返回 HTTP 200，公共 `pluginInventory/list` 确认 `@shamcleren/dsh-security-scan` 的 `fiberPhase=active`。

## 修复的发布问题

0.1.0 的 `cordis.patch.yml` 使用了不受上游支持的 `op: append` 格式。它可以通过 npm 安装和直接工具单测，但不能证明在官方 profile 中激活。本次改成公开的 `insert` 声明，并增加真实安装的 profile 合成检查。因此不能把旧版“页面可启动”的证据解释为旧插件已激活。

## 验证范围与环境

所有安装、hooks、Git 操作和模型复核测试都使用独立临时目录。没有更新用户当前 App、profile 或模型配置，也没有给用户仓库安装 hook。

受限执行环境中的最小原生 `fs.watch` 也报 `EMFILE`；放到允许原生文件监听的执行环境后，官方 Host 正常启动。没有修改上游或禁用其监听器，也没有通过调整用户系统设置解决该问题。

JSON/HTML 写入、补充发现和复核流程经过合成数据验证；真实业务仓库上的模型审计、模型修复质量和 CI 平台接入仍需用户验收。CLI 与 Git hook 不自动启动 LLM；DSH 会话可通过公开工具完成复核。没有执行真实漏洞利用、修改业务代码、创建远端流水线或系统定时任务。
