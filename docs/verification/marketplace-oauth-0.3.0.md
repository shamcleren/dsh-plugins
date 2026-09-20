# Marketplace 0.3.0 / macOS App 0.2.4 验证

日期：2026-09-09。运行时：官方 `@deepseek-ai/dsh@0.1.0-rc.8`；平台：macOS arm64。

## 自动化验证

- Marketplace Host / browser 类型检查和构建通过，59 项测试通过。
- 安装器、插件短命令和原生 App 共 50 项测试通过，包括无全局 Node 的初始化入口、默认目录、端口、签名输出的目录保护、Swift 编译与原生桥来源限制。
- OAuth 测试覆盖 PKCE、回调状态与重放拒绝、Token 刷新、禁止跨站重定向、仓库地址限制、默认分支、回调端口冲突及监听器释放。
- 回归覆盖桌面环境与安装器的 pnpm store 不一致，以及本地版本高于远端时不提示降级更新。

## 真实入口验证

在临时安装目录和独立 DSH 数据目录内，从仓库发布包安装 Marketplace，再构建并启动 `dist/DeepSeek Harness.app`；通过 codesign 深度校验和 plist 校验。默认服务端口改为 `3080`，用户已有配置与安装未用于夹具。

Chrome 中验证“设置 → 插件 → 远端市场”：来源表单只有仓库地址和 OAuth 登录入口。填写 `https://gitlab.example.com/shamcleren/dsh-plugin`，完成真实 OAuth 授权后自动读取默认分支 `main`，显示 6 个目录插件。工蜂应用登记的回调地址为 `http://127.0.0.1:3080/oauth/gongfeng/callback`，不支持将实例端口直接代入登记地址。

通过 OAuth 实际下载 WeCom Tools 发布包，完成摘要验证。最终发布代码在原生 App 启动的 Host 中，通过与界面相同的 Connection RPC 执行卸载、安装、再次卸载，均成功；安装后的实际版本为 `0.1.0`，卸载后仅保留 Marketplace `0.3.0`。同时用 `make plugin-list DIR=…` 交叉核对安装状态。

最终安装/卸载的 RPC 验证在 Mac 锁屏后继续完成，不将其表述为最后一次确认弹窗的浏览器交互验收。没有配置模型或机器人账号，没有调用模型、发送消息或更改工蜂 OAuth 应用登记信息。
