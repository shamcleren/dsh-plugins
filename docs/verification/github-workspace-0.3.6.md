# GitHub Workspace 0.3.6 验证

日期：2026-11-12。环境：macOS arm64，Node.js 26.7.0，官方 DSH `0.2.1-rc.5`。

## 修复范围

- hooks/签名检查保留托管命令的 `GIT_CONFIG_GLOBAL` 与 `GIT_CONFIG_NOSYSTEM` 隔离设置，避免把机器的全局签名或 hooks 当作项目要求。
- 用 Git 按键读取实际生效的项目配置，修复原正则查询漏检 `core.hooksPath` 的问题；签名布尔值由 Git 解析，保留项目 include 文件中的隐式开启值。
- 自动生成的提交说明以 `dsh auto commit: ` 开头；手动说明和已有提交不变。
- 保留项目自身 hooks、签名、远端分叉、暂存区、账号/分支变化和加密检查；已暂停项目升级后点击“恢复并同步”重新校验。

## 已通过

```sh
node node_modules/typescript/bin/tsc -p plugins/github-workspace/tsconfig.json --noEmit
node node_modules/typescript/bin/tsc -p plugins/github-workspace/tsconfig.client.json --noEmit
# 在 plugins/github-workspace 目录执行：
node node_modules/vitest/vitest.mjs run --reporter=verbose
# 在仓库根目录执行：
node scripts/release-plugin.mjs github-workspace
node --test scripts/tests/github-workspace-release.test.mjs scripts/tests/catalog-compatibility.test.mjs
node scripts/smoke-runtime.mjs runtime --startup-only
git diff --check
```

组件 5 个测试文件、50 项测试全部通过。临时 HOME 与本地 bare 远端中的真实 Git 操作覆盖全局签名、全局 hooks、全局 include 配置下的手动及自动提交推送，并验证远端提交说明及全局配置原样保留。项目自身 hooks 路径、原生 hooks、签名和本地 include 仍阻止绕过项目流程。

2 项发布检查通过，覆盖 catalog 源码摘要、包身份、依赖与导出完整性，以及打包客户端通过官方配置插槽挂载。目录包安装到隔离 Web profile 后，真实官方 Host 启动通过；GitHub Workspace 的认证 RPC 成功，匿名及跨源请求被拒绝。

## 目录包

- 包：`@shamcleren/dsh-github-workspace@0.3.6`
- 路径：`artifacts/shamcleren-dsh-github-workspace-0.3.6.tgz`
- 大小：76496 字节
- SHA-256：`5e33bc717a827ca2be983e8c5c8e553f232d8b508ddf9f2f1a0b1a4a60c3bea9`
- 兼容版本维持 DSH `0.2.1-rc.5`。

## 未验证及交付状态

未使用真实 GitHub 账号，未验证远端签名策略、组织授权或真实网络推送；本次 Host 检查不包含完整安装升级迁移，也不证明其他平台可用。目录包与 catalog 已在本仓准备，代码发布不会自动更新用户现有安装。
