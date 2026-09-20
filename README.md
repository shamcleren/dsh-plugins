# DeepSeek Harness 插件

一键安装官方 DSH 与 macOS 桌面版，按需添加安全扫描、微信等插件。无需修改或编译 DSH 官方源码，远端市场可选。

## 安装与启动

需要本仓库的读取权限、Git 和 make；**无需预装 Node.js、npm 或 pnpm**。macOS 请先安装命令行开发工具：`xcode-select --install`。安装过程需要联网下载依赖。

```sh
git clone https://github.com/shamcleren/dsh-plugins.git
cd dsh-plugins
make init
open "dist/DeepSeek Harness.app"
```

Linux 安装后使用 `./dist/bin/dsh` 启动 Web 版。首次打开 DSH，按界面配置模型；已有配置会直接复用。

- App 与运行时位于项目的 `dist/`，默认端口 **3080**。
- 配置文件为 **`~/.dsh/settings.yaml`**，会话、凭据和插件数据也在 `~/.dsh`。
- 基础安装不额外添加本仓库插件。已有 DSH 配置会保留，本仓库已安装插件会同步升级到兼容版本；不同安装目录或端口仍共享这份数据，请先退出原来的 DSH。

没有 make、仅安装 Web 版、自定义路径或安装失败续装，见 [安装选项](docs/installation.md)。

## 安装插件

以下命令在本仓库执行。单个插件用 `plugin install` 安装或更新；已安装的全部 catalog 插件用 `plugin update --all`。**安装、更新或卸载前先退出 DSH，完成后重新启动。**

```sh
./dhp plugin list                     # 查看插件、安装状态和版本
./dhp plugin install security-scan    # 安装或更新安全扫描
./dhp plugin install wechat           # 安装或更新微信插件
./dhp plugin install web-search       # 免费联网搜索，无需 API Key
./dhp plugin update --all             # 更新所有已安装的本仓库插件
./dhp restart                        # 启动 DSH
```

卸载使用 `./dhp plugin remove <插件名>`，保留插件数据。安装后新开终端，也可在任意目录使用 `dhp`。

| 插件名 | 用途与使用说明 |
| --- | --- |
| `security-scan` | [Python、Go、JS/TS 安全扫描与 AI 审计](plugins/security-scan/README.md) |
| `web-search` | [免费 Exa 网页搜索与正文读取，无需 API Key](plugins/web-search/README.md) |
| `desktop-share` | [macOS 分享与微信转发文件导入草稿](plugins/desktop-share/README.md) |
| `dsh-pet` | [macOS 桌面悬浮宠物与任务状态卡](plugins/dsh-pet/README.md) |
| `wechat` | [扫码绑定个人微信，自动接收对话](plugins/wechat/README.md) |
| `wecom-aibot` | [企业微信机器人](plugins/wecom-aibot/README.md) |
| `wecom-tools` | [企业微信办公工具](plugins/wecom-tools/README.md) |
| `codex-controller` | [持久 Codex 会话](plugins/codex-controller/README.md) |
| `marketplace` | [工蜂远端插件市场](plugins/marketplace/README.md) |

### 可选：通过远端市场安装

首次安装可用 `make init MARKETPLACE=1`；已有安装执行 `./dhp plugin install marketplace`。

启动后进入 **设置 → 插件 → 远端市场 → 来源设置**，填写仓库地址 `https://gitlab.example.com/shamcleren/dsh-plugin`，点击 **OAuth 登录并连接**，即可在界面安装和更新插件。请保留默认端口 3080，供 OAuth 回调使用。

远端市场与 DSH 原生插件管理并存；本地命令安装不需要市场授权。源码安装等用法见 [插件管理指南](docs/plugin-management.md)。

## 开始安全扫描

安装 `security-scan` 并启动 DSH 后：

1. 点击侧边栏 **安全扫描**。首次自动准备 Semgrep、Gitleaks 和独立 Python；失败时可在“扫描设置”重试。
2. 新建任务，填写本地代码路径或仓库 URL，选择全量、增量或暂存区扫描，点击 **保存并运行**。
3. 在 **运行记录** 查看进度，进入 DSH 执行会话观察工具调用与审查过程；结束后打开报告。对话发起的扫描直接在原会话继续，工作台发起时创建新会话。

也可以选择项目，在 **安全审计** 模式的对话中直接说：

> 使用 security-review 扫描当前项目，生成中文 HTML 报告，给出问题依据和修复建议。

新任务和对话启动默认开启 **依赖漏洞、密钥泄露检测、Agentic AI**，明确关闭时按你的选择执行；已有任务保留原设置。AI 默认跟随 DSH 默认模型，也可在任务中下拉选择已配置模型；复用原生执行流程，安全审计模式包含 Shell、文件、搜索等基础工具，沿用 DSH 沙箱与审批。

报告以中文 HTML 展示，支持筛选分组、点击文件行号查看内嵌代码、查看证据与修复建议，JSON 用于留档。任务界面还可管理历史基线、Git hooks、编辑后自动检查，以及删除已结束的运行记录和历史报告。

依赖查询会向 OSV 发送包名与版本，AI 会将必要源码片段交给你配置的 DSH 模型。阅读报告时先看扫描范围与覆盖缺口；“已结束”不代表所有代码均安全。CLI 和 Git hooks 使用规则检查，不自动启动 AI。更多用法见 [安全扫描说明](plugins/security-scan/README.md)。

## 更新

退出 DSH 后，在仓库中执行：

```sh
git pull --ff-only
./dhp update                          # 更新仓库锁定的 DSH 与 App
./dhp restart
```

`make init` 可以重复执行，会复用或更新安装并保留配置；日常更新推荐用 `dhp update`。当前锁定官方 DSH **0.1.5-rc.1**（2026-09-11 核对的 npm `latest`），运行时升级会同步更新本仓库已安装插件。不会自动追踪未经验证的新版本。

已有 DSH 可直接升级：新版凭据保持原样，旧平面凭据先备份到 `~/.dsh/.dhp-backups/`，再由官方 DSH 转换。请退出所有使用同一 `~/.dsh` 的旧 App/CLI；升级后不要再用旧运行时读取这份数据。第三方插件不兼容时会在替换前提示，详见 [兼容与恢复](docs/installation.md#已有-dsh-的兼容与恢复)。

## 开发

仅开发源码时需要准备 Node.js 和 pnpm；普通用户无需执行以下命令。

```sh
pnpm install --frozen-lockfile --ignore-scripts
pnpm typecheck
pnpm test
pnpm build
pnpm test:macos   # macOS 应用壳验证
```

插件源码位于 `plugins/`，应用壳位于 `apps/macos/`，官方运行时锁定位于 `runtime/`。用户安装的是 [marketplace.json](marketplace.json) 指向的发布包；发布时需同步版本、构建产物和摘要。

更多说明：[上游兼容](docs/upstream-migration.md) · [安装设计](docs/decisions/unified-bootstrap.md)。
