# Security Scan 0.10.0 验证

2026-09-11，官方 DSH 0.1.0-rc.8，macOS arm64。

- 运行记录与历史报告提供独立删除入口和确认说明。删除记录保留任务、报告及原生会话；删除报告删除 HTML/JSON 并清理关联记录的报告按钮。活动记录、发布中的报告、配置或活动扫描使用的基线受保护。拒绝未知目录内容、符号链接、身份不匹配和非法 ID；状态保存失败时还原报告和引用。
- 新工作台任务与 session 的 security_start_scan 默认开启 dependencies、secrets、agent_review。显式 false 和已有任务选择保留。规则级工具/CLI 的用途没有变成另起 AI。测试对话入口真实保存的配置与工作台初始化一致，默认启动配置测试不调用真实模型或 OSV。
- 报告搜索与四个筛选控件实测均为 40px 高、14px 字号；筛选和操作分行。在隔离 Host 的真实 iframe 中搜索 app.py，3 项过滤为 1 项。实际界面检查新任务三项默认勾选、两种删除确认说明和取消操作；永久删除由隔离临时目录的服务/RPC 回归验证，没有操作用户报告。
- 安全审计预设复用官方 bash/pwsh、文件读写、搜索、Skills、后台任务工具。原白名单会把预设自己的工具从后代会话中移除；改为排除无关的已有全局工具，后台执行器按当前 Agent 作用域保留基础工具。官方 Config 与 apply 在预设所有的上下文中注册，生命周期随预设释放；不修改上游模块、宿主沙箱或审批。
- 安装后的官方 profile + 额外测试 patch 挂载真实安全审计预设，确认 bash/read/write/edit/glob/grep/skill/job_output/job_list/job_kill 和扫描入口存在。通过官方 tools.execute 实际执行 pwd、读取测试 app.py 成功；Shell 返回 sandbox.mode=workspace-write、enforcement=full。测试会话使用随机 ID，结束释放 Agent；3198 测试 Host 已停止。
- 原生 Agent 回归实际注册官方 bash 工具，确认基础工具可调用、宿主 guard 仍可拒绝操作、原始读取不能冒充已归档引用。90 项回归全部通过（无跳过），包含真实 Semgrep 与安装包的官方 profile 加载入口；TypeScript、构建及 git diff --check 通过。

最终包与构建目录及隔离安装逐文件核对，package.json 按 JSON 内容比较；catalog 大小和 SHA-256 一致。具体摘要以 marketplace.json 为准。

未更新用户正式 App、修改真实配置/历史报告、调用真实模型、提交或推送代码。Windows 的 pwsh 分支已声明依赖与类型检查，本机没有进行 Windows 执行验证。
