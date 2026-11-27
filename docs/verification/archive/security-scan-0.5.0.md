# Security Scan 0.5.0 验证

日期：2026-09-10。目标环境：macOS arm64，官方 DSH 0.1.0-rc.8；未修改官方模块或用户安装。

## 自动扫描环境

- 清空的隔离 profile，PATH 仅 `/usr/bin:/bin`，通过指定 Node 启动插件 CLI；未提供 Python、Semgrep 或 Gitleaks 路径。自动下载校验 uv 0.8.22，准备私有 Python 3.13.7、Semgrep 1.176.1 和 Gitleaks 8.24.2，成功执行版本检查。
- Python Flask eval、Go TLS、JavaScript HTML sink 的合成仓库，全量扫描命中 3 项候选，Semgrep 和 Gitleaks 均为 completed；OSV 未启用。第二次调用复用同一 generation，没有重新安装。
- 最终 tarball 经 `make plugin-install` 安装到独立 profile。`make scan ACTION=setup` 和带显式默认命令名的 `make scan ... SCANNER=semgrep GITLEAKS=gitleaks SECRETS=1` 均通过，CLI 不会用默认名称覆盖已解析的托管路径。
- 首次准备失败、重试、并发去重、保留未知锁/目录、摘要错误、归档链接拒绝、自定义路径跳过安装、等待者取消与插件关闭均有回归覆盖。
- Linux glibc ≥ 2.34 arm64/x64 和 macOS x64 有固定发布资产清单；未在这些平台执行真实安装，不宣称已实机验证。

## 工作台

最终发布包安装后，由隔离 App 在 3198 启动真实 Host，自动完成环境准备；浏览器通过独立入口创建默认规则+密钥任务，保存运行并打开 HTML，3 种语言扫描覆盖 3/3。任务与报告保留 JSON 数据。

展开侧栏：安全扫描与原生设置按钮左边缘均为 10px、宽 260px、高 42px，图标左边缘 18px、尺寸 16px。收起侧栏：两按钮均为 36px，图标尺寸 18px、水平中心线相同。

工作台使用顶部导航、环境卡片和折叠高级设置。1280px 与 680px 宽度实际渲染检查通过，窄窗口 main 的 scrollWidth 等于 clientWidth，没有横向溢出。测试后恢复浏览器 viewport，关闭测试页及 App；3198 端口与任务锁释放。保留用户接管的旧 3196 实例。

## 检查与产物

- TypeScript typecheck、客户端和服务端构建通过。
- 插件 55 项测试通过，无跳过，含真实 Semgrep 和官方 profile loader。
- 根目录工程脚本 45 项测试通过，无跳过。
- App 0.2.7 原生 16 项测试及真实构建通过；保存面板期间菜单退出验证见 [0.4.0 记录](security-scan-0.4.0.md)。
- marketplace 中 0.5.0 的包身份、大小、SHA-256 与 tarball 一致；所有包内文件与本次构建及源资源逐文件一致。0.4.0 发布包保留原样。

Agentic AI 的真实模型验收和完整工具流程沿用 [0.4.0 记录](security-scan-0.4.0.md)；本次未重复调用真实模型。上述验证证明接线和行为，不代表在真实漏洞基准上的召回率或准确率。
