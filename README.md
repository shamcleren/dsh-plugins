# DeepSeek Harness 个人 AI 工作台

基于官方 DeepSeek Harness 的个人 AI 工作台，连接桌面与微信，提供开发、安全扫描、资料整理和任务结果交付。按需启用独立插件，通过公开扩展点接入，无需修改 DSH 官方源码。

日常可以在桌面处理项目，在微信中发起任务、处理审批并接收结果。`dhp mode list` 提供远程开发与资料简报的组合入口，`dhp mode plan <场景 ID>` 查看准备步骤和任务示例。

## 安装与启动

需要 Git、make 和 GitHub 网络访问；**无需预装 Node.js、npm 或 pnpm**。macOS 请先安装命令行开发工具：`xcode-select --install`。安装过程需要联网下载依赖。

```sh
git clone https://github.com/shamcleren/dsh-plugins.git
cd dsh-plugins
make init
open "dist/DeepSeek Harness.app"
```

Linux 安装后使用 `./dist/bin/dsh` 启动 Web 版。首次打开 DSH，按界面配置模型；已有配置会直接复用。

- App 与运行时位于项目的 `dist/`，默认端口 **3080**。
- 实时配置保存在 **`~/.dsh/profiles/web/cordis.patch.yml`**；旧 `settings.yaml` 首次启动时由官方导入，并保留备份。会话、凭据和插件数据仍在 `~/.dsh`。
- 基础安装不额外添加本仓库插件。已有 DSH 配置会保留，本仓库已安装插件会同步升级到兼容版本；不同安装目录或端口仍共享这份数据，请先退出原来的 DSH。

没有 make、仅安装 Web 版、自定义路径或安装失败续装，见 [安装选项](docs/installation.md)。

## 安装插件

以下命令在本仓库执行。单个插件用 `plugin install` 安装或更新；已安装的全部 catalog 插件用 `plugin update --all`。**安装、更新或卸载前先退出 DSH，完成后重新启动。**

```sh
./dhp plugin list                     # 查看插件、安装状态和版本
./dhp status                          # 查看运行状态、DSH/App 版本和待更新项
./dhp doctor                          # 只读检查安装、升级兼容性、端口与备份
./dhp plugin install security-scan    # 安装或更新安全扫描
./dhp plugin install im               # 统一接入微信与企业微信
./dhp plugin install web-search       # 免费联网搜索，无需 API Key
./dhp plugin update --all             # 更新所有已安装的本仓库插件
./dhp restart                        # 启动 DSH
```

卸载使用 `./dhp plugin remove <插件名>`，保留插件数据。安装后新开终端，也可在任意目录使用 `dhp`。

| 插件名 | 用途与使用说明 |
| --- | --- |
| `security-scan` | [Python、Go、JS/TS 安全扫描与 AI 审计](plugins/security-scan/README.md) |
| `web-search` | [免费 Exa 网页搜索与正文读取，无需 API Key](plugins/web-search/README.md) |
| `github-workspace` | [自动准备 GitHub CLI，按组织接入仓库，解锁 git-crypt 并按项目同步](plugins/github-workspace/README.md) |
| `desktop-share` | [macOS 分享与微信转发文件导入草稿](plugins/desktop-share/README.md) |
| `dsh-pet` | [macOS 桌面悬浮宠物与任务状态卡](plugins/dsh-pet/README.md) |
| `im` | [统一管理微信与企业微信、工作区、对话、审批和消息通知](plugins/im/README.md) |
| `wecom-tools` | [企业微信办公工具](plugins/wecom-tools/README.md) |
| `marketplace` | [Git 仓库市场](plugins/marketplace/README.md) |

### 可选：通过 Git 仓库市场安装

首次安装可用 `make init MARKETPLACE=1`；已有安装执行 `./dhp plugin install marketplace`。

启动后进入 **设置 → 插件 → Git 仓库市场 → 来源设置**。工蜂地址点击 **OAuth 登录并连接**（回调端口 3080）；GitHub 公开仓库填写 `https://github.com/owner/repo` 后点击 **保存来源**。

Git 仓库市场与 DSH 原生插件管理并存；本地命令安装不需要市场授权。源码安装等用法见 [插件管理指南](docs/plugin-management.md)。

## 开始安全扫描

安装 `security-scan` 并启动 DSH 后：

1. 点击侧边栏 **安全扫描**。首次自动准备 Semgrep、Gitleaks 和独立 Python；失败时可在“扫描设置”重试。
2. 新建任务，填写本地代码路径或仓库 URL，选择全量、增量或暂存区扫描，点击 **保存并运行**。
3. 在 **运行记录** 查看进度，进入 DSH 执行会话观察工具调用与审查过程；结束后打开报告。对话发起的扫描直接在原会话继续，工作台发起时创建新会话。

也可以选择项目，在 **安全审计** 模式的对话中直接说：

> 使用 dsh-security-review 扫描当前项目，生成中文 HTML 报告，给出问题依据和修复建议。

新任务和对话启动默认开启 **依赖漏洞、密钥泄露检测、Agentic AI**，明确关闭时按你的选择执行；已有任务保留原设置。AI 默认跟随 DSH 默认模型，也可在任务中下拉选择已配置模型；复用原生执行流程，安全审计模式包含 Shell、文件、搜索等基础工具，沿用 DSH 沙箱与审批。

报告以中文 HTML 展示，支持筛选分组、点击文件行号查看内嵌代码、查看证据与修复建议，JSON 用于留档。任务界面还可管理历史基线、Git hooks、编辑后自动检查，以及删除已结束的运行记录和历史报告。

依赖查询会向 OSV 发送包名与版本，AI 会将必要源码片段交给你配置的 DSH 模型。阅读报告时先看扫描范围与覆盖缺口；“已结束”不代表所有代码均安全。CLI 和 Git hooks 使用规则检查，不自动启动 AI。更多用法见 [安全扫描说明](plugins/security-scan/README.md)。只需要安全扫描时，也可以从 [独立仓 shamcleren/dsh-security-scan](https://github.com/shamcleren/dsh-security-scan) 的 Release 直接安装。

需要不消耗模型 Token 时，关闭任务的 Agentic AI 或直接使用 CLI；外层 AI 对话本身仍可能计费。当前产品是静态扫描、可选的只读运行时基线检查（对你授权的服务地址发送最多 12 个同源 GET 请求，不是完整 DAST）以及可选 AI 源码审计；修复会话完成后自动复扫，剩余问题可继续下一轮修复。包内 29 条规则覆盖 Flask/Django、Express/Koa/Next.js/React、net/http/Gin/Echo 等常见框架；标记为误报的问题在后续扫描中自动隐藏，可在扫描设置中恢复。`uv.lock` schema v1 已纳入可选依赖检查。0.15 升级的工具/Skill 名称变更见 [迁移说明](plugins/security-scan/docs/guide.md#015-工具命名迁移)。

## 更新

先执行 `./dhp update --check` 查看兼容性和准备情况；退出 DSH 后，在仓库中执行：

```sh
git pull --ff-only
./dhp update                          # 更新仓库锁定的 DSH、已安装插件与 App
./dhp restart
```

`make init` 与 `dhp update` 共用幂等的更新与修复流程：完整且未变化的内容直接复用，缺失或摘要变化的受管运行时、启动器、私有 Node.js 和 App 会暂存重建，保留用户配置。安装失败后可重新执行 `make init`，日常使用 `dhp update`；详情见[重复执行与恢复](docs/installation.md#重复执行与更新)。当前锁定官方 DSH **0.2.1-rc.5**（2026-10-30 核对，npm `latest` / `next`），每次更新都会检查并同步本仓库已安装插件，DSH 版本不变时也会更新插件。不会自动追踪未经验证的新版本。已明确退役的本仓库插件（目前为 `codex-controller`）会经官方卸载流程移除，保留配置、凭据和会话；仅从目录消失的未知插件不会自动删除。

已有 DSH 可直接升级：新版凭据保持原样，旧平面凭据先备份到 `~/.dsh/.dhp-backups/`，再由官方 DSH 转换。请退出所有使用同一 `~/.dsh` 的旧 App/CLI；升级后不要再用旧运行时读取这份数据。第三方插件不兼容时会在替换前提示，详见 [兼容与恢复](docs/installation.md#已有-dsh-的兼容与恢复)。

## 开发

本项目直接在 [GitHub 主仓](https://github.com/shamcleren/dsh-plugins) 维护，需求与问题使用 Issues，代码变更通过 PR 和 CI 检查。开发、发布与安全扫描独立仓的同步方式见 [GitHub 维护说明](docs/github-maintenance.md)。

仅开发源码时需要准备 Node.js 和 pnpm；普通用户无需执行以下命令。

```sh
pnpm install --frozen-lockfile --ignore-scripts
pnpm --dir runtime install --frozen-lockfile --ignore-scripts
pnpm typecheck
pnpm test
pnpm build
pnpm test:macos   # macOS 应用壳验证
```

插件源码位于 `plugins/`，应用壳位于 `apps/macos/`，官方运行时锁定位于 `runtime/`。用户安装的是 [marketplace.json](marketplace.json) 指向的发布包；发布时需同步版本、构建产物和摘要。

更多说明：[上游兼容](docs/upstream-migration.md) · [安装设计](docs/decisions/unified-bootstrap.md)。
