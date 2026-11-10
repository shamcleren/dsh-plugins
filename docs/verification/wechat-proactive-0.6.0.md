# 微信主动通知 0.6.0 验证

2026-11-10，macOS arm64，官方 DSH `0.2.1-rc.5`。微信插件新增跨会话文本通知工具及 Host 调度调用服务，官方源码未修改。

| 验证 | 结果 |
| --- | --- |
| `pnpm --filter @shamcleren/dsh-wechat typecheck` | 通过，保持严格类型与现有宿主版本约束。 |
| `pnpm --filter @shamcleren/dsh-wechat test` | 20 个文件、89 项测试通过。 |
| `pnpm --filter @shamcleren/dsh-wechat build` | Host、声明及 Web client 构建通过。 |
| `node --test scripts/tests/catalog-compatibility.test.mjs scripts/tests/plugins.test.mjs` | 16 项测试通过，包括包身份、兼容约束、大小、摘要及安装器行为。 |
| `node scripts/smoke-runtime.mjs runtime --startup-only` | 最终 catalog tarball 安装至隔离 profile，真实官方 Host 启动通过；26 个插件工具与 2 个 Skill 加载，其中包括全部 4 个微信工具；`wechatPush` 服务注入成功，认证 Web 页面与只读 RPC 验证通过。 |

回归覆盖多账号歧义、精确收件人、微信及派生 Session 隔离、原生工具权限拒绝与卸载注销、幂等与冲突、共享窗口额度、Unicode 分块、已接受分块断点恢复、HTTP 429 延迟且不被新入站提前解除、context 更新竞态、未知投递结果不重发、损坏状态保留、凭据变更、取消、过期及停机等待。调用方自定义取消原因不会标记全局存储故障；等待发送槽而未派发的通知在重载后仍可恢复。

发布包为 `artifacts/shamcleren-dsh-wechat-0.6.0.tgz`，大小与 SHA-256 的权威记录位于 `marketplace.json`。现有账号数据格式保持兼容；首次启用主动通知需要接收一条新消息建立可发现收件人。

本次使用隔离目录、模拟 iLink 响应及无账号官方 Host。未向真实微信联系人发送消息，未配置真实定时任务或调用模型；无账号启动不能替代真实账号的送达验收。用户现有安装与 profile 未参与夹具，更新需由用户执行 `dhp update` 并重新启动。
