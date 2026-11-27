# Security Scan 0.9.1 参数兼容性验证

2026-09-10，官方 DSH 0.1.0-rc.8，macOS arm64。

只读核对用户原生 session security-b166b83e-bf8e-4f77-842d-6d16712bee49：第 19 轮 submit_review 提交了 20 条 reviews，却没有提供 findings，触发 Zod invalid_type。第 20 轮补上 findings: [] 后保存成功，最终任务 succeeded。分析只输出工具名、参数键和数量，没有回显源码、凭据或模型推理。

修复：reviews / findings 缺省为空数组，发布给模型的 JSON Schema 使用输入模式，与实际解析一致。至少需提交一项结果；空对象、null、错误类型和缺失引用仍拒绝。中文纠正提示附静态允许字段的路径和期望类型，不回显未知参数名、原始值或 Zod 自由文本。

TypeScript、构建通过。新增原生 Agent 回归复现 20 条复核省略 findings，一轮成功且无 rejected 事件；同时验证只提交新增发现、错误类型与缺失引用的拒绝和恢复。完整回归 83 项通过，无跳过，包含真实 Semgrep 与最终安装包的官方 profile 加载入口。

最终包 74 个文件与构建及独立 profile 安装内容一致，catalog 大小 / 摘要验证通过。SHA-256：344cfeb34a3b1189f59df7764516cbb1c4a174a0c078bf720d2294eb9f3d30bc。

没有更新正式 App、重新执行业务扫描、修改历史会话或推送代码。旧错误轨迹保留，不影响原任务已成功保存的结果。
