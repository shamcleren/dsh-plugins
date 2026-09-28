# Marketplace 0.4.7 宿主适配

2026-09-28，锁定 DSH `0.1.7-rc.2`。

## 实现

- 通过公开 `ctx.profileContext` 读取当前目录、安装锚点，不再把 Web 目录作为默认目标。旧 `profile` 配置仅为兼容设置导入而保留，不用于选择操作目录。
- 安装、更新、卸载使用公开 `ctx.pluginManager`，由官方管理器持有包管理进程、脚本审批、兼容性校验、文件锁、失败恢复与加载生命周期。无需推断 `process.argv[1]` 是 CLI，也不修改官方模块。
- 安装 spec 带有经过 catalog 校验的包名及本地摘要校验包路径，使重复安装同一文件时仍能确定包身份。
- 消息插件的 `before-web-app` 顺序使用公开 manifest API，在与官方管理器相同的文件锁下重读并保存，再交给管理器激活。保留其他 manifest 字段，不使用旧快照覆盖并发修改。
- 界面尊重管理器的 applied / restart-required 结果，批量操作合并重启需求；拒绝把 failed / cancelled / overridden 当作成功。官方 Desktop 不显示自建 WebKit 原生重启按钮。

## 已通过

- Marketplace 类型检查、构建、74 项测试。
- Catalog 发布包兼容性检查。
- 隔离 Web Host：10 个 catalog 包加载，设置和鉴权回归通过；真实卸载、重装及同包重复更新通过。
- 未修改的官方 Desktop `0.1.7-rc.2` Host：市场正确识别当前 desktop profile 的全部 10 个插件，设置、预设、鉴权和安全扫描会话测试通过。

## 验证边界

官方 Desktop 内置包管理器的真实卸载连续两次出现超时。第二次日志明确记录 `Done in 3.2s using pnpm v11.7.0`，但包管理调用一直未返回，120 秒后测试超时；第一轮进程检查也确认 pnpm remove 子进程仍在运行。官方 Desktop 写操作尚不能声明验收通过，没有用外部包管理器替换官方包内组件来掩盖差异。测试 Host 与子进程已清理。真实外部账号与桌面 GUI 交互未验证。本次未替换本机应用或修改用户 profile。

复现入口为 `scripts/smoke-runtime.mjs`，官方发布包模式增加 `--desktop-app=/path/to/DeepSeek Harness.app`。夹具只替换远端 catalog 读取，使用真实已校验 tarball 和真实官方管理器执行包操作。
