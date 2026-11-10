# GitHub 维护

项目主开发仓为 [shamcleren/dsh-plugins](https://github.com/shamcleren/dsh-plugins)。代码、Issues、PR、CI 和目录包均在这里维护，直接修改本仓源码，不再从另一个主仓覆盖同步。迁移前的旧仓保留历史，私有扩展、账号数据及本地配置继续留在原位置，不属于公开开发树。

## 开发与检查

```sh
git clone https://github.com/shamcleren/dsh-plugins.git
cd dsh-plugins
pnpm install --frozen-lockfile --ignore-scripts
pnpm --dir runtime install --frozen-lockfile --ignore-scripts
pnpm typecheck
pnpm build
pnpm test
```

从最新 `main` 创建工作分支，建议使用 `codex/` 前缀；通过 PR 审查后合入。官方运行时继续独立锁定在 `runtime/`，不将其锁文件合并进开发 workspace。全量安装器测试需要上述独立运行时依赖；macOS 应用壳另用 `pnpm test:macos` 验证。GitHub Actions 在 Linux 与 macOS 上执行类型、构建和单元测试；macOS 验证应用壳，Linux 额外验证实际发布包的隔离 Host 启动。原生宠物 Helper 仅在 macOS 构建。

## 发布目录包

行为变更同步组件文档与回归测试，增加组件版本后构建并打包至 `artifacts/`。同步 `marketplace.json` 的版本、大小、SHA-256 和实际验证的 DSH 兼容版本。只保留目录引用的当前包；不得用不同字节覆盖已发布版本。迁移时已有的 `-public.1` 包保持身份及摘要，后续修订以新版本发布。

```sh
node scripts/release-plugin.mjs wechat
node --test scripts/tests/catalog-compatibility.test.mjs
```

发布前先递增组件版本。`release-plugin.mjs` 清理该组件的生成目录、构建并暂存打包，将运行源码、Skill、构建配置和依赖锁的摘要同时写入发布包和 catalog；已有发布身份不可覆盖。校验同时检查源码摘要和完整打包清单，防止删除的代码仍留在发布包中。

运行时或发布包变更还需在临时 `HOME/DSH_HOME` 中运行 `scripts/smoke-runtime.mjs` 验证真实官方 Host。此脚本需要单独准备的 `runtime/node_modules`；CI 的 workspace 构建与单元测试不替代真实账号或运行时验收。普通用户退出 DSH 后执行 `git pull --ff-only`、`./dhp update`，再重新启动；代码发布不自动更新任何已有安装。

完整升级烟测还需要匹配旧运行时的旧仓库检出目录（包含旧 catalog 和发布包）：

```sh
node scripts/smoke-runtime.mjs runtime --update --previous-runtime=/path/to/old/runtime --previous-repo=/path/to/old/release-checkout
```

## 安全扫描独立分发仓

[shamcleren/dsh-security-scan](https://github.com/shamcleren/dsh-security-scan) 继续作为单插件分发仓，唯一源码在本仓 `plugins/security-scan/`。这里保留导出器、独立锁文件和 CI 模板：

```sh
pnpm --filter @shamcleren/dsh-security-scan build
node scripts/export-security-scan.mjs --dest /path/to/dsh-security-scan
```

依赖变化时加 `--refresh-lock`，检查并提交独立锁文件。导出后检查分发仓 diff，验证 install/typecheck/test/build；GitHub Release 或 npm 分发使用 catalog 中同版本、同摘要的原始 tarball。独立仓的修复先移回本仓，再重新导出，避免形成两个开发源。

## 迁入内容

2026-11-10 将当前工作区迁入已有 GitHub `main` 历史，包括 DSH `0.2.1-rc.5` 配套插件、安装器、macOS 应用壳、安全扫描 `0.18.0`，以及微信 `0.6.0` 的跨会话和定时任务主动通知。迁移不包含旧私有 Git 历史、私有扩展或用户 profile；这些内容继续保留在旧目录。公开开发树保留第三方许可与架构决策。
