# 重复初始化与 WeChat 0.3.0 验证

日期：2026-09-10。平台：macOS arm64；官方 DSH：`0.1.0-rc.8`；macOS App：`0.2.5`。

## 自动化验证

- 工程脚本 44 项、macOS 14 项测试通过，包含无全局 Node/npm 的 shell 入口、重复执行、显式重打包、旧版数据目录和桌面端口保留、运行中拒绝更新、暂存安装、插件 peer 不兼容拒绝、构建失败及发布后验证失败回退、事务恢复和路径越界拒绝。macOS 测试实际编译 Swift。
- 微信 33 项测试、类型检查、Host/client 构建通过。使用真实 Cordis Context、公共 SettingsProvider 和插件入口，模拟 iLink 确认回调，验证保存启用状态、追加账号选择、按扫码身份推导用户和管理员权限、启动及卸载清理；缺少扫码身份时不启动。
- 登录完成等待自动启用成功；启用失败保留凭据并返回失败状态。Remote 响应 codec 保留扫码用户身份，浏览器状态不含 token。已有非空自定义权限保持有效。

## 真实安装与启动

从提交 `b5ccf61` 的旧安装器在临时目录安装带 Marketplace 0.3.0 的 App 0.2.4，使用独立数据目录和端口 3186。再通过当前 `make init DIR=…` 原地更新运行时依赖锁和 App，未重复传入 Marketplace 或数据目录选项。

- 更新后 App 为 0.2.5，固定路径为 `<测试安装>/DeepSeek Harness.app`；原来的数据目录和端口 3186 保留，签名及 plist 校验通过。
- 更新前后，测试 settings.yaml、profile package.json 和 pnpm-lock.yaml 的 SHA-256 完全一致。再次执行直接返回 `Already up to date`；`REBUILD=1` 完成真实重打包。
- 真实打开生成的 App，Host 返回 HTTP 200。App 运行时，`make init REBUILD=1` 在构建前拒绝更新，提示关闭该安装的 App/Web，没有终止进程。
- 用 `make plugin-install PLUGIN=wechat DIR=…` 安装最终 0.3.0 tarball；包身份、版本、大小与 SHA-256 校验通过。重新打开 App 后，HTML 包含微信 client contribution；只读 `wechatLogin/state` 经官方 Connection RPC 返回 `{ accounts: [], status: 'idle' }`，证明发布包的 Host Remote 服务正常加载。`make plugin-list` 显示微信和 Marketplace 均为 0.3.0。

## 范围

本次真实更新验证的是同一官方 rc.8 版本下的依赖锁更新和 App 重打包；没有把未验证的新 DSH 版本加入兼容声明。未来版本的 peer 不兼容拒绝使用合成版本夹具测试，不能替代该版本的真实功能验收。

所有安装和启动使用临时目录；用户现有 DSH 配置和账号未作为夹具。微信扫码到启用的链路使用模拟回调，真实微信扫码、收发消息和模型回答尚未验收。测试 App 已正常退出。
