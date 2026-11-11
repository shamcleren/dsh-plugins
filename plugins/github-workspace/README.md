# GitHub 项目工作区

将选定的 GitHub 仓库克隆到本机并加入 DSH 工作区。按个人账号、组织、其他协作仓库分层选择；每个项目可以手动审阅提交，也可以单独开启自动提交推送。运行时固定验证为 DSH `0.2.1-rc.5`，通过公开的 Workspace Registry、Connection 和插件页面扩展点接入。

## 安装与使用

本机需要提供 Git。插件在后台准备 GitHub CLI（`gh`）：优先复用本机可用版本，缺少时自动下载官方固定版本 **2.103.3**，校验内置 SHA-256 后安装到 `DSH_HOME/github-workspace/tools/`。支持 macOS / Linux 的 arm64、x64，不需要 Homebrew、sudo 或全局安装。页面显示准备进度，离线或下载失败可点击 **重试准备**，无需重启 Host；校验失败拒绝执行，卸载会取消下载并等待清理。

插件复用 GitHub CLI 的账号与凭据管理，不读取或复制 token，也不改全局 Git credential helper。私有安装的 `gh` 同时供登录、GitHub API 与 Git 凭据 helper 使用。凭据存储以 `gh auth status` 为准；环境变量 `GH_TOKEN` / `GITHUB_TOKEN` 存在时，GitHub CLI 优先使用它们。

退出使用该 profile 的工作台后安装发布包并重新启动：

```sh
dhp plugin install github-workspace
dhp start
```

1. 在侧栏 **插件 → 已安装 → GitHub 项目工作区** 打开页面。已登录 GitHub CLI 时直接显示账号；否则点击 **登录 GitHub**，复制一次性验证码，在 GitHub 授权页面完成登录。
2. 先在 **个人 / 组织** 下拉框选择范围，再通过仓库下拉框和搜索筛选选择项目；仓库按所选范围分页加载，点击 **加载更多** 继续读取。其他协作仓库覆盖非成员组织或其他个人账号直接授予的协作访问。
3. 点击 **打开到工作区**。下载在后台执行，任务卡显示检查、克隆、接收对象、注册工作区等阶段和可取得的对象进度。期间仍能切换组织、搜索或取消任务；取消会等待自身进程与临时克隆目录清理完毕。打开后在 DSH 工作区选择器切换到该项目并创建会话。
4. 完成修改后，在 **本地改动** 页选择文件并点击 **预览所选改动**。审阅完整差异，可编辑自动生成的提交说明。
5. 点击 **确认提交到本地**，然后在 **概览** 页点击 **推送到 GitHub**。推送失败保留本地提交，可处理问题后重试。
6. **检查远端** 更新远端跟踪状态；**拉取更新** 只在本地没有改动且能快进时执行。分支分叉、合并或变基未完成时，先在项目内处理，再刷新页面。

## git-crypt 加密仓库

先选择仓库，再展开 **仓库加密**，选择 **本地密钥文件** 或 **本机 GPG 密钥环**，点击 **保存并打开工作区**。若直接打开未配置的加密仓库，插件保留克隆，提示配置后重试；解锁成功才注册工作区。当前支持已有的 git-crypt 默认密钥仓库，不代替 `git-crypt init` 创建加密规则，也不支持命名密钥、SOPS、git-remote-gcrypt 等其他机制。

需要本机已有 `git-crypt` 0.7.x / 0.8.x；插件会查找 PATH、Homebrew 常用路径，也可在高级设置填写绝对程序路径。macOS 可通过 `brew install git-crypt` 安装，Debian/Ubuntu 可通过 `sudo apt-get install git-crypt` 安装。选择 GPG 时还需本机 GPG 私钥及仓库对应的 GPG 授权；有密码的私钥需先在系统密钥环解锁。

页面设置的权威来源是 `DSH_HOME/github-workspace.encryption.json`，也可在首次运行前手写此文件；默认 DSH_HOME 为 `~/.dsh`。仓库名不区分大小写，支持绝对路径和 `~/`，不展开环境变量，不执行命令。例如：

```json
{
  "version": 1,
  "repositories": {
    "your-account/private-notes": {
      "mode": "git-crypt",
      "keySource": "file",
      "keyFile": "~/.config/git-crypt/private-notes.key"
    },
    "your-team/shared-notes": {
      "mode": "git-crypt",
      "keySource": "gpg",
      "binaryPath": "/opt/homebrew/bin/git-crypt"
    }
  }
}
```

只保存密钥路径，不粘贴或导出真实密钥。对称密钥文件须在受管工作区之外且仅本人可读，例如权限 `600`；git-crypt 自身在项目 `.git` 内保存其所需的本地解锁状态。密钥引用用于解锁，修改引用不会轮换仓库密钥。移除配置也不会删除已解锁的本地数据或关闭仓库原有加密规则。

本地工作文件解锁后供工作区正常读写，Git 对象仍保持密文。手动提交与自动同步都会验证加密文件，推送前还检查待推送历史，避免把中间曾出现过的明文一并推上去。插件内不接受修改加密规则；规则移除、缺少密钥、错误密钥、未完成解锁或检查失败会阻止保存/同步；加密审查最多覆盖 100 个待推送提交、2000 个文件变更、64 MiB 密文，超限需人工审查分批推送。加密文件的差异预览只显示二进制变化，正文在本地编辑器审阅。页面修改加密设置会关闭该项目自动同步，验证后需自行重新开启。

## 每个项目的自动同步

在项目 **概览 → 保存方式** 选择 **自动提交并推送**，再选择 1–60 分钟的同步间隔（页面提供 1、5、15、30、60 分钟）。该选择授权此项目在 Host 运行时自动提交支持的普通文件并推送，也会推送已有本地提交；默认 5 分钟。也可以点击 **立即同步**。已有项目升级后保持手动模式，只有明确为其开启才会同步。

同步绑定启用时的 GitHub 账号与分支，先检查远端状态。远端新增提交、分支或账号变化、现有暂存改动、hooks/签名要求、超出文件限制及其他检查错误会暂停自动同步并显示原因。它不自动拉取、合并、变基、强推或反复重试失败项目。处理问题后点击 **恢复并同步**；分支变化时该动作会重新绑定当前分支。改回手动模式会取消并等待当前自动同步任务，然后保存关闭状态。

后台定时器由插件实例持有，卸载会取消任务并等待退出；持久设置和项目文件保留，重启后仍已开启的正常项目继续按间隔同步。若要升级已安装的插件，退出工作台后执行 `dhp update` 再启动。

## 数据与同步边界

项目及归属记录位于 `DSH_HOME/github-workspace/`。相同仓库重复打开会复用本插件管理的目录和原生工作区；未知目录、符号链接和已有锁不会被覆盖或自动清除。克隆或工作区注册失败保留归属记录，可重试；进程被强制结束留下的锁需核实归属后处理。卸载插件不会删除项目文件、Git 历史或 GitHub CLI 的账号。

GitHub 保存已提交并推送的项目文件和版本历史。聊天记录、模型配置与其他 DSH 数据不随项目自动上传。本版不自动克隆全部仓库、不强推、不自动合并、不自动创建仓库或 PR；Git 子模块、LFS 对象和项目依赖也不自动下载或安装。

凭据文件、`.env`（示例模板除外）、私钥等已知敏感路径不接受提交；单个普通文件上限 5 MiB，差异上限 1 MiB。这不是完整的密钥扫描，其他文件仍需审阅。预览使用独立索引，不改已有暂存区；提交检查预览是否过期或文件是否变化，只写入审阅过的树，并保留其他已暂存改动。提交作者为当前 GitHub 账号及其 noreply 邮箱。

插件不执行仓库 hooks、外部 diff/textconv 或项目脚本。它使用隔离的 Git 全局配置、GitHub CLI 凭据 helper 和 HTTPS GitHub 远端；GitHub 的分支保护等远端策略照常生效。采用 `commit-tree` 建立审阅快照；检测到本机或项目配置的 hooks 路径、启用的提交 hooks 或提交签名时，拒绝插件内提交，提示先在终端按项目约定提交。配置了推送 hooks 时，同样要求在终端推送，不绕过既有检查。

## 开发验证

```sh
pnpm --filter @shamcleren/dsh-github-workspace typecheck
pnpm --filter @shamcleren/dsh-github-workspace test
pnpm --filter @shamcleren/dsh-github-workspace build
```

回归测试用临时本地 bare 仓库替代网络传输，执行真实 Git 克隆、审阅、提交、推送和拉取，覆盖空仓库、暂存区保留、过期预览、敏感路径、锁、远端分叉、组织分页、后台取消、自动同步暂停、认证 RPC 和退出清理。浏览器验收使用隔离演示数据，检查组织选择、仓库搜索、后台任务期间的交互、取消、差异预览以及窄窗口和深色主题。这些检查不代替真实 GitHub 账号与组织授权验收。

布局回归须将 catalog 发布包安装到隔离的官方 Web profile，在 **插件 → 已安装插件 → GitHub Workspace** 中检查。分别以 1280、627、390 像素窗口验证面板填满配置区（上限 1180 像素）、仓库选择自动换行，以及展开本地密钥和高级设置后输入框仍处于卡片内。宿主配置插槽中的 flex 布局与面板的 inline-size containment 共同决定宽度，独立预览须补充此集成检查。

交互参考：[GitHub Desktop](https://docs.github.com/en/desktop/adding-and-cloning-repositories/cloning-and-forking-repositories-from-github-desktop) 的仓库选择、[Obsidian Git](https://github.com/Vinzent03/obsidian-git) 的按间隔自动同步，以及 DSH 社区的 [dsh-worktree](https://github.com/Eleven-is-cool/dsh-worktree) 和 [dsh-git-graph](https://github.com/WhitePlusMS/dsh-git-graph)。参考交互与功能边界，没有引入这些插件的运行时或源码依赖；它们与本项目锁定 DSH 的兼容性需要单独验证。
