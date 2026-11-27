# Security Scan 0.10.2 验证

2026-09-11，macOS arm64，官方 DSH 0.1.0-rc.8。

## 原会话执行

- 对话启动的运行记录直接保存相同的 originSessionId / sessionId，复用存活 Agent，通过公开 followup 在启动轮次之后执行。工作台保留独立执行会话。
- 临时工具在扫描消息被 inbox/claimed 领取时同步挂载，早于原生系统提示和工具目录组装。首次安装验证发现 pre-step 挂载会使首个审计请求缺少工具声明，已修复并增加首步工具声明断言。
- 原生 turn/end 同步撤销临时贡献，不等待整个 Agent 空闲，不销毁借用会话。回归验证保留会话模型、后续普通轮次恢复工具、排队取消只移除扫描消息、活动取消保留其他待办输入。

## 实际安装验证

- 通过 dhp plugin install 将 0.10.2 安装到隔离 profile，在 3198 端口启动官方 Web profile。公开测试 patch 提供脚本化模型适配器，在真实 Agent 内调用 security_start_scan；规则阶段运行真实 Semgrep。
- 启动轮次和审计轮次均由原生运行时正常结束。Agent 列表始终只有同一个会话；持久化运行记录的两个 session ID 相同，最终状态 succeeded / finished。
- 首个审计模型请求已经声明 plan_review 等工具。原会话中依次保留启动、规划、取证、检查点及 HTML 报告通知；报告 HTML / JSON 均实际生成。审计结束后原 Agent 仍存在，临时审计工具已卸载。
- 测试模型只验证调度与工具链，没有复核三条规则候选；报告明确保留 0/3 待复核和覆盖缺口，没有把流程成功标记成无漏洞。

## 检查与范围

- TypeScript、构建通过；97 项测试全部通过，无跳过，包含真实 Semgrep 和安装包的官方 profile 加载。
- 发布包 80 个文件与构建目录、隔离安装逐文件一致，package.json 按 JSON 内容比较。大小为 226167 字节；SHA-256 为 db81e397bbd8d179bd0ca83577f916bc152a74b7584a7460862ce0b79b102a62，与 marketplace.json 一致。
- 隔离服务验收结束后关闭。未更新正式 App 或用户 profile，未调用真实模型、提交或推送代码。实际模型的审计质量仍需用户使用自己的仓库和模型验收。
