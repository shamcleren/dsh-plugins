# Security Scan 0.16.1 独立发布验证

日期：2026-11-06。环境：macOS arm64；官方 DSH 0.2.1-rc.5；GitHub Actions Ubuntu 24.04。此记录对应首次单独发布到 GitHub 的版本，不表示已更新任何现有用户安装。

## 变更

- 功能与 0.16.0 相同。包元数据新增 `repository`、`homepage`、`bugs`、`keywords` 与 `packageManager`，并声明独立开发所需的 TypeScript、Vitest 与 Node 类型依赖；报告版本同步为 `0.16.1`。
- 新增 `scripts/export-security-scan.mjs`，把插件导出为可独立开发的脱敏仓库：带发布构建的 `lib/`、独立 `pnpm-lock.yaml`、`.gitignore` 与 CI 模板（位于插件的 `standalone/`，不进入发布包），拒绝内部 Git 主机名、AIDEV 与本机路径，并按自身清单清理过期文件。dsh-plugins 公开导出不包含这些独立仓模板与脚本。
- 中英文 README 以 GitHub Release 地址作为首选安装方式，CLI 示例统一为 `dsh-security`；贡献说明改为独立仓的 issue/PR 流程与 pnpm 命令。测试中的内部主机名替换为示例域名。

## 通过的检查

- 内部仓：TypeScript 严格检查、Host/Client 发布构建通过；插件测试 19 个文件、176 项通过、1 项可选安装目录测试跳过，已启用真实 Semgrep。根目录 export-public、catalog 兼容与独立导出测试共 8 项通过；发布包测试通过；隔离 Playwright UI 脚本通过；开发 Node 26.7.0 下官方 Web 入口启动检查注册 20 个工具和 2 个 Skills，授权页面与安全扫描 RPC 正常。
- 独立导出：在全新临时目录 `git init` 后执行冻结安装、类型检查、测试（176 项通过，真实 Semgrep）与构建均通过；导出树不含内部主机名、AIDEV、本机路径与个人标识。
- GitHub Actions（Ubuntu 24.04、Node 22）：冻结安装、类型检查、测试与构建通过，174 项通过、3 项跳过（Runner 没有 Semgrep，两项依赖真实 Semgrep 的用例跳过）。
- 发布资产：从公开 Release 地址下载的 tarball 与 catalog 包大小、SHA-256 一致。使用官方 0.2.1-rc.5 CLI 在隔离 `HOME`/`DSH_HOME` 中执行 `dsh plugin --profile web add <Release URL>` 成功，profile 登记了 bundle 并创建 `dsh-security` 短命令；该命令完成评测基线门禁，无回归。

## 发布

- 公开仓：`https://github.com/shamcleren/dsh-security-scan`，`main` 为脱敏导出。
- Release：`v0.16.1`，附件即 catalog 包。
- 组件版本：`0.16.1`；报告版本：`0.16.1`；DSH 声明：仅 `0.2.1-rc.5`。
- 文件：`artifacts/shamcleren-dsh-security-scan-0.16.1.tgz`，145 个文件。
- 大小：`306397` 字节。
- SHA-256：`73a3bbd90df6e6024dc76bee2379e0d82a498f3417a03164835b8cc0f1ffd29f`。
- 未发布到 npm。

## 验证边界

只验证了 DSH 0.2.1-rc.5，0.2.2 预发布版未验证。真实扫描只在 macOS arm64 上验证；Linux 仅由 CI 覆盖构建与不依赖 Semgrep 的测试，Windows 与官方 Electron 桌面 UI 未验证。Release 安装只在隔离 profile 中验证 CLI，未在该 profile 中启动 Web 界面。修复闭环未调用真实模型完成端到端修复，未发送真实 OSV 请求，运行时检查未对真实部署执行。未修改任何用户 profile。
