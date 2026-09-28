# 安装选项与故障恢复

日常安装、启动与更新见 [项目 README](../README.md)。

## 环境要求

安装入口支持 macOS/Linux 的 arm64、x64，需要 Git、make、curl、tar，以及 shasum 或 sha256sum。macOS 构建桌面 App 还需要 Xcode Command Line Tools，可运行 `xcode-select --install` 安装。Linux 需要兼容官方 Node.js 二进制的 glibc 环境。

无需预装 Node.js/npm/pnpm，也无需先安装本仓库开发依赖。安装器会复用兼容的 Node.js/npm，或下载锁定版本、验证 SHA-256 后安装到本次安装目录；不修改系统目录或全局 npm 包。

没有 make 时使用：

```sh
sh scripts/init.sh
```

安装后会将 `dhp` 链到 `~/.local/bin`，必要时在 shell 配置中追加带标记的 PATH 设置。新开终端后生效；仓库内可直接用 `./dhp`。

## 自定义安装

更新前运行 `./dhp status`，可在 DSH 运行中只读查看进程、数据目录、已安装 DSH/App 版本与仓库目标版本，以及运行时依赖刷新、应用壳重建、启动器刷新和已安装 catalog 插件的版本替换。插件缺失或指向本仓库源码时，也会列出待安装的发布包。

这里的目标是当前仓库锁定的发行版本，与 `dhp update` 一致；不联网检查上游 latest，也不自动执行更新。`aligned` 表示对应版本或构建输入一致，不代表安装完整性或第三方插件兼容性已验证；完整校验、私有 Node 修复和迁移检查仍由更新器执行。存在未完成的更新事务或读取失败时，预览会明确提示不可用或不完整。

确认目标后再执行 `./dhp update`。自定义安装使用 `./dhp --dir /absolute/path/dsh-plugins status` 查看。

```sh
# 指定安装目录，首次使用不存在的目录
make init DIR=/absolute/path/dsh-plugins

# macOS 仅安装 Web 版，不需要 Xcode 开发工具
make init WEB_ONLY=1

# 自定义桌面端口；远端市场 OAuth 使用默认 3080
DSH_APP_PORT=3082 make init DIR=/absolute/path/dsh-plugins
```

自定义目录后，管理命令须选择相同目录：

```sh
./dhp --dir /absolute/path/dsh-plugins plugin list
./dhp --dir /absolute/path/dsh-plugins update
./dhp --dir /absolute/path/dsh-plugins restart
```

App 固定为 `<安装目录>/DeepSeek Harness.app`，Web 启动器为 `<安装目录>/bin/dsh`。两者都使用安装时记录的数据目录，新安装默认为 `~/.dsh`。**安装目录和端口不同不代表数据隔离**，不要同时启动多个实例访问同一 profile。端口占用时安装器不会终止其他服务。

旧版安装仍保留原位置和数据目录，不会自动迁移。管理旧安装时指定它的目录，例如 `./dhp --dir "$HOME/.local/share/dsh-plugins" plugin list`。安装记录包含绝对路径，请勿直接搬动安装目录。

## 重复执行与更新

`make init` 和 `dhp update` 共用更新与修复流程，可重复执行。安装器记录受管运行时、私有 Node.js、启动器和 App 的内容及可执行权限摘要；构建输入和实际内容都没有变化时不重装、不重写安装记录。缺失或损坏的受管内容会在暂存目录中重建并校验，再通过事务替换。已声明但缺少包信息的 catalog 插件会重新安装。旧安装没有内容摘要时，首次更新会重建受管组件，建立校验基线。

重复执行会沿用记录中的 Web-only/桌面类型和数据目录，桌面更新保留记录的端口与签名设置；不必重复传入 `WEB_ONLY=1`。更新前先退出该安装的 App 和 Web 服务。模型配置、凭据、会话及第三方插件会保留；本仓库已安装插件同步到当前 catalog 版本。

摘要用于发现安装后的损坏，不替代发布包的 SHA-256 校验或真实启动验证。它不诊断模型账号、网络连通性，也不承诺修复第三方插件或用户配置。

日常更新用 `./dhp update`；需要在源码无变化时也重新打包 App，用 `./dhp update --rebuild`。更新使用暂存目录和回滚机制，不追踪上游 `latest`。

首次选择过 `MARKETPLACE=1` 的安装也使用 `dhp update`。不要通过改变初始化选项来增删市场；添加插件使用 `dhp plugin install …` 或远端市场界面，更新已安装的本仓库插件使用 `dhp plugin update --all`。

## 安装失败后继续

普通安装失败后，重新执行同一条命令即可续装，也可仅指定原安装目录。未完成安装会读取已记录的 Web-only、市场和构建选项；`RESUME=1` / `--resume` 仍兼容，但不再必需。例如：

```sh
make init
# 恢复自定义目录，沿用该安装已记录的选项
make init DIR=/absolute/path/dsh-plugins
```

若 `dhp` 启动器本身丢失，回仓库执行 `make init`。新版 `dhp` 在其 Node.js 无法运行时会将 `update` 交给 shell 初始化入口，复用可用 Node.js 或重新下载并校验锁定发行包。重复初始化也会复用安装内可用的私有 Node.js/npm。

安装记录损坏或缺失、且没有可验证的更新事务证明目录归属时，安装器会停止，不会把现有目录当成全新安装覆盖。安装器拒绝接管不属于自己的目录，也不会自动删除锁文件。如果异常退出遗留 `.bootstrap.lock`，先核实其中记录的进程确实已结束，再处理锁；不要在安装仍运行时删除它。

更多行为约定见 [安装设计](decisions/unified-bootstrap.md)。

## 已有 DSH 的兼容与恢复

本次兼容基线为官方 `0.1.7-rc.2`，桌面运行时使用锁定的 Node 24。凭据由该版本官方解析器校验，不需要删掉 `.credentials.yaml` 或手工降级格式。

- 旧 `settings.yaml`：更新前保存权限为 `600` 的摘要副本，包括已有的 `.imported` 文件。官方首次启动将可用字段导入 Profile 配置；旧默认预设的 `agent-presets.default` 由安装事务转为 `agent-preset-registry.selectedDefault`，不覆盖已明确设置的新字段。
- 旧 V3 会话：由官方迁移到 V4；隔离验证覆盖 Codex 和安全扫描消息，并确认旧一代日志保留。
- 原来使用新版凭据：校验后保持文件原样。
- 旧平面凭据：先保存权限为 `600` 的副本至 `<DSH_HOME>/.dhp-backups/credentials-<摘要>.yaml`，再由官方凭据服务在首次启动时升级。
- 已装本仓库插件：从校验过的发布包，在暂存 profile 中准备匹配版本；保留用户 patch 和其他配置，成功后留下旧 profile 备份。准备失败不替换现有 profile；发布被中断后，下次初始化按安装记录完成恢复。
- 未验证的第三方插件：不擅自升级或移除；peer 依赖不匹配时停止替换，并报告具体包及版本要求。需先通过原安装更新/移除冲突插件，或使用独立数据目录。
- 凭据格式未知、文件通过符号链接指向别处或权限不符合官方要求时明确报错，不修改内容。若提示权限问题，核实文件属于当前用户后执行 `chmod 600 "$HOME/.dsh/.credentials.yaml"`。

安装器不会卸载全局 DSH，也不会终止其他安装的进程。**升级前请退出所有共用这份数据的 DSH。** 新版官方会话和凭据可能执行单向格式升级；旧 App/CLI 不保证能读取升级后的数据。需要继续使用旧运行时，请让新安装使用独立目录：

```sh
DSH_HOME="$HOME/.dsh-preview" make init DIR="$HOME/dsh-preview" WEB_ONLY=1
"$HOME/dsh-preview/bin/dsh" web --host 127.0.0.1 --port 3082 --no-open
```

首次选择的数据目录会写入安装记录，后续 `make init`/`dhp update` 继续使用它；不会随终端环境变量自动搬迁。Web 启动时使用官方输出的完整授权 URL；桌面 App 会自动完成此握手。日志位于 `<安装目录>/logs/launcher.log`。
