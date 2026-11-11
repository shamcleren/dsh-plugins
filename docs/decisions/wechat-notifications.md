# 微信主动通知的路由与投递语义

微信插件通过官方工具注册接口暴露 `wechat_notify` 等工具，通过公开的 `@shamcleren/dsh-im/wechat/push` 导出提供 `wechatPush` Cordis 服务。DSH 原生定时任务继续负责唤醒原 Session，不增加另一套调度器或修改官方运行时。支持范围保持为仓库锁定并验证的 DSH 版本。

## 收件人与调用者

收件人由机器人账号和微信对端共同确定，以稳定摘要标识，只接受实际入站建立的对端。单账号普通 Session 默认给扫码本人发送；多账号必须显式选择。微信 Session 只能给自己的当前绑定对端发送，旧 Session 失去绑定后拒绝主动发送。工具查询和回执查询保持 Session 隔离；可信 Host 服务由其调用插件负责业务授权。

凭据变更后，旧通知失败，不自动改投新身份。队列只保存凭据摘要，不保存 bot token 或 context token，发送时读取当前凭据及对端上下文。现有 `accounts.json` 格式不变，通知状态独立放在权限为 0600 的 `outbox.json`。

## 所有权与恢复

入队返回持久化回执，投递由插件拥有，原调用完成或取消不撤销已接收的通知。显式取消仅适用于尚未派发的通知。每个分块调用前持久化发送状态与额度，成功后保存分块进度。插件停止接收新工作，取消在途请求并等待工作结束，重载恢复排队状态。

服务端执行与客户端收到响应之间存在不确定区间。网络断开、超时、5xx、格式错误和进程中断的在途消息标记为 `uncertain`，不自动重发。每个通知分块的 `client_id` 稳定，但不假设服务端提供幂等保证。HTTP 429 明确拒绝的请求可延后重试。context/窗口拒绝等待新入站，不删除 token 再尝试。成功回执只表示 iLink 接受，不表示客户端呈现或用户已读。

普通回复和通知共用每对端串行槽与保守窗口额度；通知预留两条回复额度。重复入站不刷新窗口。全账号主动分块至少间隔十秒，队列容量、通知存活期、回执保留期都有上限。幂等键在保留范围内区分调用 Session，定时任务必须以具体发生次序或时间作为键的一部分。数值、调用示例与错误语义以[插件说明](../../plugins/im/README.wechat.md#proactive-notifications)为准。

## 参考依据

- [pan17/dsh-wechat](https://github.com/pan17/dsh-wechat/tree/6b2fd2b69c766a9610235764fd0a7d18ce86d592)：主动工具、待发队列与互动窗口的设计参考。
- [Carl-5535/dsh-wechat-gateway](https://github.com/Carl-5535/dsh-wechat-gateway/tree/b73607243c30d4d8082404c4506ea476eb35c6cc)：跨会话工具及 Host 发送服务的设计参考。
- [Tencent iLink 协议参考](https://github.com/Tencent/openclaw-weixin/blob/main/docs/protocol.md)：回复携带入站 `context_token`，可选类型字段不构成服务端接受缺失字段的保证。

本次实现为本仓库独立代码。窗口和额度是基于社区行为采用的保守客户端策略，不扩大为腾讯服务端完整契约，也不扩大插件的运行时兼容声明。
