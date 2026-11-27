# DSH 0.1.5 自定义 RPC 兼容性验证

验证日期：2026-09-11。

DSH `0.1.5-rc.1` 的 Connection 自定义通道会把外部插件的 `rpc.handle()` 注册归属到 Connection 自身 fiber。该 fiber 没有声明 `webServer`，安全扫描和远端市场的 Host 路由因此没有挂载，请求落到 Web 前端 fallback 并返回 HTTP 405。

兼容版本改由插件自身通过公开的 `webServer.register()` 注册路由，并继续复用 Connection 的 Host/Origin 检查、浏览器会话鉴权和请求信封格式：

- Security Scan `0.11.1`
- Trusted Marketplace `0.4.1`
- AIDEV `0.3.1`

回归先用修复前发布包在官方 Web profile 中复现 `/security-scan/state` 返回 405；随后把新 tarball 安装到全新的隔离 `DSH_HOME`，由真实 DSH Web 入口交换浏览器令牌并请求 `/security-scan/state` 和 `/trusted-marketplace/state`，两条路由均返回合法的 HTTP 200 Connection 响应。AIDEV 的组合测试使用真实 WebServer 请求 `/aidev/state`，确认路由不再落入 fallback。

三个组件的 typecheck、单测和构建均通过；catalog 中的版本、包路径、字节大小和 SHA-256 来自最终 tarball。测试使用隔离目录，未更新现有安装或用户配置。
