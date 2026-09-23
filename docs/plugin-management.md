# 插件管理

远端市场和本地安装共用这个 Git 仓库：`plugins/` 是源码，`artifacts/` 是预构建包，[marketplace.json](../marketplace.json) 定义发布版本、兼容范围、加载位置和摘要。先按 [README](../README.md) 完成 `make init`，之后可在任意目录使用 `dhp`（若刚写入 PATH，先开一个新终端）。

## 常用短命令

插件安装使用 `dhp plugin install <插件名>`：未安装则安装，已安装则更新到当前仓库的发布版本。`dhp plugin update --all` 只更新 profile 里已经声明的 catalog 插件，不会把未安装的也装上。`dhp update` 更新 DSH 运行时和 App，并同步升级已安装的本仓库插件；运行时版本不变时仍检查插件更新。市场目录缓存随运行时或已安装插件版本变化而失效，下次打开市场自动从已配置的可信来源刷新。

DSH `0.1.6-alpha.2` 的侧栏提供官方「插件」页面，可管理插件安装、配置与启停。微信、企微机器人、AIDEV 和桌宠的设置卡片位于各自的已安装插件页面；本仓库的远端市场继续负责私有 catalog。MCP 仍使用官方 MCP Client 配置条目，OAuth 授权由对应服务或 transport 处理；该页面不等同于专门的 MCP 登录与连接管理中心。

该版本发布包对配置求值异常仍可能整体启动失败；MCP 配置应在缺少必需凭据时条件禁用，并保持 `failOnStartupError: false`。普通连接失败允许 Host 继续启动，但等待授权或慢连接仍可能延迟就绪。实测边界见 [0.1.6 兼容验证](verification/dsh-0.1.6-compatibility.md)。

| 操作 | 命令 |
| --- | --- |
| 首次安装并加入远端市场 | `make init MARKETPLACE=1` |
| 已有 DSH，补装远端市场 | `dhp plugin install marketplace` |
| 安装或更新微信插件发布包 | `dhp plugin install wechat` |
| 安装免费联网搜索 | `dhp plugin install web-search` |
| 构建并安装微信插件源码 | `dhp plugin install wechat --source` |
| 更新所有已安装的本仓库插件 | `dhp plugin update --all` |
| 查看本仓库插件、安装状态和版本 | `dhp plugin list` |
| 卸载微信插件 | `dhp plugin remove wechat` |
| 执行插件提供的 CLI | `dhp plugin exec security-scan -- --help` |

插件名使用 catalog 的 `id` 或完整包名；`marketplace` 是 `trusted-marketplace` 的简写。当前其他短名有 `wecom-aibot`、`wecom-tools`、`codex-controller`、`security-scan`、`desktop-share`、`dsh-pet` 和 `web-search`。不支持的名称会列出可用选项，不会当作任意安装路径执行。

如果初始化时指定过 `DIR`，后续命令也指定同一目录，例如：

```sh
dhp --dir "$HOME/.local/share/my-dsh" plugin install wechat
```

这些命令复用安装器提供的 Node.js 和 pnpm。`make init` 会把 `dhp` 安装为用户命令。它们使用目标安装记录中的 Web profile：新安装默认是 `~/.dsh/profiles/web`，旧安装可能仍在 `<安装目录>/home/profiles/web`。修改 profile 前先退出使用这份数据的 DSH，完成后重启。

## 重启与配置生效

安装、更新、卸载插件会改变 profile 的依赖或 bundle 清单，需要重新启动 Host 加载。安装命令的成功提示来自 `scripts/plugins.mjs`；完成本批变更后统一执行一次 `dhp restart`。

macOS 客户端已经运行时，`dhp restart` 通过 App 内的 `DeepSeekHarnessControl` 向该安装的客户端发送独立的重启请求。客户端进程继续运行，停止旧 Host 后启动新 Host；因此从 Harness 内部的 AI Shell 工具调用，也能在工具进程结束后完成重启。命令返回仅表示重启请求已交付，启动失败仍会显示在客户端；Host 输出见安装目录的 `logs/launcher.log`。点击 Dock 或重新打开窗口只确保 Host 正在运行，不触发重启。0.2.10、0.2.11 或版本不明的 App 若缺少控制程序，会明确要求更新或重建；已知更早版本保留旧的重新打开事件兼容路径。

不要用 `kill`、`pkill` 或进程搜索后发送信号的方式重启 DSH，也不要在内部 Bash 中串联“停止、等待、直接启动 node/bin.js”。这会绕过 `dhp restart`，而旧 Host 退出时会清理 Bash，后半段启动无法可靠执行。原生壳通过官方 `--patch` 和 `systemPrompt.section` 扩展点，将此规则与当前安装的重启命令加入模型上下文，不改写用户 profile 或官方模块。

原生壳 0.2.12 起，在已就绪的 Host 意外退出时自动恢复，包括收到 SIGTERM 后以状态 0 退出的情况。恢复在 60 秒内最多安排 3 次，分别等待 1、2、4 秒；连续退出超限或新 Host 尚未就绪就失败时，保留错误供排查。显式重启重置恢复次数；退出客户端或执行 `dhp stop` 会取消待执行的恢复。恢复仍检查安装更新锁和端口归属，端口被其他进程占用时停止，不终止占用者。日志记录每次 Host 启动、就绪、退出及恢复安排。

重启会结束当前 AI 回合，不会自动继续未完成的任务。客户端恢复后可以在原会话中继续。Web 模式（包括 `--web` 或从 App 切换为 Web）仍使用停止再启动的流程，应从外部终端执行重启。

普通配置修改不一定需要重启：`cordis.patch.yml` 是否热加载由 profile 的 `dsh.profile.patchReload` 控制，`live` 为热加载，`startup` 为下次启动生效；当前锁定运行时在该字段缺省时按 `live` 处理。热加载不等于重新读取依赖清单或重新加载已安装的包代码。插件设置还应遵循对应插件的生效规则，例如 AIDEV 的连接、凭据或策略设置会明确提示重启 Host。不要仅因修改了 MCP 配置就推断必须重启整个客户端。

## 查看本地列表

`dhp plugin list` 列出当前仓库 catalog 中的所有插件，显示“已安装 / 未安装”、实际安装版本和本地发布版本。无论通过远端市场、发布包还是源码安装，都按同一个包名识别；`marketplace` 可直接用于后续安装、卸载命令。

列表从目标 Web profile 读取实际安装状态，不联网、不修改配置，查看时无需退出 DSH。尚未创建 profile 时全部显示“未安装”；如果 profile 已声明依赖但缺少对应安装包，则显示“安装不完整”。已安装表示包存在，不代表插件已启用或运行正常。本地发布版本来自当前仓库的 `marketplace.json`，拉取仓库后才能看到新发布版本。

## 通过 Remote Market 管理

安装 Git 仓库市场后，启动 DSH，打开“设置 → 插件 → Git 仓库市场 → 来源设置”，填写 `https://gitlab.example.com/...` 或 `https://github.com/owner/repo`。工蜂地址点击“OAuth 登录并连接”；GitHub 公开仓库点击“保存来源”，不需要授权。连接后自动读取该仓库的默认分支和插件目录，随后可搜索、安装和更新。

工蜂 OAuth 使用默认端口 `3080`。它只把令牌发给 `gitlab.example.com`，不会发给 GitHub。不需要 Token、Application ID、分支配置或 `gongfeng` CLI。已授权时可以直接保存另一个工蜂仓库；授权失效可点“重新授权”。GitHub 私有仓库不会读取。旧版 Private Token 不再作为登录凭据。来源授权只负责读取远端目录和包，插件自己的账号、模型和机器人设置独立管理。本地安装不需要安装或授权这个市场。

## 安装本地发布包

```sh
dhp plugin install wecom-tools
```

默认自动选择 catalog 中该插件的 `.tgz`，校验 DSH 版本、包名、版本号、大小和 SHA-256；校验失败时不会调用安装命令。校验通过的包缓存在实际 DSH 数据目录的 `plugin-cache/`，避免 profile 依赖易变的仓库路径。随后通过官方 DSH CLI 安装，禁用生命周期脚本。

命令会自动按 `placement` 调整加载顺序，包括微信和企业微信机器人的 `before-web-app` 要求，不再需要手动编辑 `package.json`。本地发布包安装不要求 `pnpm install` 或编译源码，但运行依赖仍可能需要联网下载。

更新时先拉取仓库，再执行：

```sh
git pull --ff-only
dhp plugin update --all
```

只更新其中一个已安装插件时，仍可使用原来的安装命令：

```sh
dhp plugin install wecom-tools
```

## 从源码构建并安装

```sh
dhp plugin install wecom-tools --source
```

`--source` 会在开发仓库安装冻结的开发依赖、关闭依赖安装脚本，执行目标包的构建命令，检查 Host/浏览器入口和 bundle 文件，再安装本地目录并处理加载顺序。此模式明确执行仓库的构建脚本，不要求手动设置 PATH 或拼写包名。

目录安装依赖本地源码及其构建产物，不要移走源码目录。修改后再次执行这条命令并重启 DSH，不保证热更新。需要分发时再按仓库发布流程打包，不要覆盖已发布的同版本文件。

## 卸载、切换来源与高级用法

`dhp plugin remove …` 使用包名卸载，兼容 pnpm 的脚本禁用配置；无论插件最初由远端还是本地安装都可以使用。它移除依赖和 bundle 启用记录，不清空设置、凭据、会话或插件数据。

远端和本地按包名识别同一个插件，不需要安装两份。远端目录包含该包时，远端市场能识别本地安装的版本；选择远端更新后，DSH 改用 catalog 中的发布包，本地源码改动不会自动上传或合并。

短命令仅管理本仓库 catalog 中的插件。对于其他 npm 包或自定义路径，仍可使用安装器生成的 `bin/dsh plugin --profile web …` 官方 CLI。直接调用官方 CLI 不会自动处理本仓库 catalog 的摘要和加载位置。

`dhp plugin exec <name> -- <args...>` 只负责查找已安装插件在 `package.json` 中声明的唯一 `bin`，并使用该安装记录的 Node.js 与 `DSH_HOME` 执行。命令语义、参数和退出码仍由插件自己定义；没有 CLI、声明多个 CLI 或尚未安装的插件会被拒绝。因此安全扫描不是 `dhp` 的内置能力，而是 `security-scan` 插件自己的 `dsh-security` CLI。

安装和卸载命令会通过 profile 中的 `.local-plugin.lock` 串行保护，遇到已有锁时拒绝执行。正常结束或失败会释放锁；异常退出遗留的锁需确认原进程已结束后再处理。失败时会恢复 profile manifest 和 lockfile，但不删除插件数据，也不承诺撤销已经产生的开发构建文件或所有依赖目录变动。
