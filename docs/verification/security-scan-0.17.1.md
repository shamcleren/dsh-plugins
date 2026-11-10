# Security Scan 0.17.1 验证

日期：2026-11-06。环境：macOS arm64；官方 DSH 0.2.1-rc.5；Semgrep CE 1.176.1。此记录不表示已更新任何现有用户安装；已安装用户执行 `dhp update` 换到该发布包。

## 变更

- 扫描行为与 0.17.0 相同，只更新报告版本号。
- README 改为面向新用户的简介：能力、安装、第一次扫描、网络与模型使用、效果与局限，并留出截图和演示视频的位置。原有完整说明移到 `docs/guide.md` 与 `docs/guide.en.md`，并随包发布。
- 包元数据增加 `publishConfig.access: public` 与 `osv`、`sarif` 关键词，为后续发布到 npm 做准备。npm 只接收同一个 Release tarball，见 [决策记录](../decisions/security-scan.md#standalone-distribution-0161)。

## 通过的检查

- 插件：TypeScript 严格检查、Host/Client 发布构建通过；测试 20 个文件、183 项通过、1 项可选安装目录测试跳过，已启用真实 Semgrep。
- 根目录脚本测试 121 项通过，包含解包真实 0.17.1 tarball 后的评测基线门禁、uv.lock 扫描、运行时检查和 CLI 误报排除循环。
- 隔离 Playwright UI 脚本通过。
- 官方 Web 入口启动检查：注册 20 个工具和 2 个 Skills，授权页面与安全扫描 RPC 正常。

## 发布

- 组件版本：`0.17.1`；DSH 声明：仅 `0.2.1-rc.5`。
- 文件：`artifacts/shamcleren-dsh-security-scan-0.17.1.tgz`，208 个文件，不含内部主机名、AIDEV 或本机路径。
- 大小：`337890` 字节。
- SHA-256：`e2421177c6202ec77bd96e5a56ac9bb6927a714abcf7ac7d79de4a178ba98fbd`。
- 尚未发布到 npm，也未提交到任何第三方插件市场。

## 验证边界

与 0.17.0 相同：只验证了 DSH 0.2.1-rc.5 和 macOS arm64；Windows 与官方 Electron 桌面 UI 未验证。未修改任何用户 profile。
