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

完成安装后可重复执行 `make init`；输入没有变化时复用，仓库锁定的运行时或应用壳发生变化时更新。更新前先退出该安装的 App 和 Web 服务。模型配置、凭据和会话会保留；运行时升级时同步更新本仓库已安装的 profile 插件。

日常更新用 `./dhp update`；需要在源码无变化时也重新打包 App，用 `./dhp update --rebuild`。更新使用暂存目录和回滚机制，不追踪上游 `latest`。

首次选择过 `MARKETPLACE=1` 的安装也使用 `dhp update`。不要通过改变初始化选项来增删市场；添加插件使用 `dhp plugin install …` 或远端市场界面，更新已安装的本仓库插件使用 `dhp plugin update --all`。

## 安装失败后继续

未完成的首次安装需要显式续装，并保留原来的 `DIR`、`WEB_ONLY` 和 `MARKETPLACE` 选项。例如：

```sh
make init RESUME=1
# 首次带有自定义选项时，续装也带上
make init DIR=/absolute/path/dsh-plugins MARKETPLACE=1 RESUME=1
```

安装器拒绝接管不属于自己的目录，也不会自动删除锁文件。如果异常退出遗留 `.bootstrap.lock`，先核实其中记录的进程确实已结束，再处理锁；不要在安装仍运行时删除它。

更多行为约定见 [安装设计](decisions/unified-bootstrap.md)。

## 已有 DSH 的兼容与恢复

本次兼容基线为官方 `0.1.5-rc.1`。它支持旧平面凭据和 `0.1.5-alpha.1` 使用的 `version / records / refs` 格式，不需要删掉 `.credentials.yaml`、重新绑定账号或手工改成旧格式。

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
