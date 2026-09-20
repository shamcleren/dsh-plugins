# Codex 会话镜像

日期：2026-09-14。插件源码版本 `0.3.0`。官方运行时仍为 `0.1.5-rc.1`，Codex 协议固定为 `@openai/codex@0.153.4` 的 app-server。不修改上游源码。

## 会话映射

一个 DSH `SessionId` 对应一个 Codex `threadId`。活动会话独占一个 app-server 连接；会话卸载或插件退出时有序停止进程树。thread id 写入插件通知 `codex-thread:`，工作副本默认写在 `DSH_HOME/codex-controller`，也可通过插件配置 `journalDirectory` 指定。重启后优先 `thread/resume`；失败则 `thread/start`，并在会话中说明先前线程不可用。

不把 `codex/*` 写成必需会话事件。公开 `Session.append` 不能标记 `ignorable`，未声明的必需事件会让持久化会话在重启后无法加载。线程映射的通知属于已有 `user/message`，可从会话日志恢复；不另做活动卡片。记录写入失败时回合失败，不假装映射已保存。

同一会话的回合串行。不同会话使用不同连接和 thread。标题与压缩请求由适配器本地回答，不启动 Codex turn，也不回放历史。只把最新的人类用户文本及附件交给当前 thread。

## 事件

只把回复、推理摘要和已完成的生成图片送进 DSH 标准流。不把命令、计划、diff、警告或未识别事件投影成输入框上方的卡片或会话通知。`item/completed` 中状态为 `completed` 的 `imageGeneration` 必须包含有效 PNG；插件校验后写入 DSH 附件存储，并输出原生 assistant 图片块。按图片 id 去重，不把 Codex 图片工具伪装成 DSH `tool/call`；存储失败时在本回合输出明确错误。内置 `image_gen` 是否可用仍由 Codex 的账号、认证和模型能力决定。

用户图片沿用 DSH 已准入的持久附件引用。适配器只读取最新人类消息拥有的图片；Host 文件路径可用时投影成 Codex `localImage`，否则重新读取并校验附件后投影成 data URL。纯图片消息可以启动回合，不把本机路径写入会话或诊断日志。

其他任意文件沿用 DSH 在适配器分发前执行的通用文件投影：原始 `FileBlock` 被确定性的 handle 文本替换，其中包含文件名、字节数、摘要前缀和当前执行环境可读的只读保存路径。Codex 通过自己的文件工具按需读取，不重复发送文件字节，也不在插件中另造第二套文件协议。音频和视频在 DSH 中仍属于通用文件，不声明原生多媒体输入能力。

不在会话头显示上下文填充百分比。`account/rateLimits` 的已用比例换成剩余百分比，由插件持有一份账号快照：启动时读取上次结果，之后每 60 秒刷新；已打开的连接优先直接读取，否则短时探测。任一连接收到 `account/rateLimits/updated` 也会更新这份快照。所有 Codex 会话头显示同一份；有 `resetsAt` 时显示重置时间。缺少已用比例则不替换已有快照，也从不编造百分比。刷新失败保留上次成功值。非 Codex 会话不显示这条状态。不把额度写进单个会话记录。

不展示未公开的隐藏思维、原始 stderr、凭据或协议内部帧，也不编造它们。未知事件直接略过。

## 审批与问答

DSH 审批结果只映射为 `accept` / `decline` / `cancel`。权限请求只回显被请求的子集，且 `scope` 固定为 `turn`。不使用 `acceptForSession`，也不提交 exec-policy amendment。

命令、文件、权限请求，以及只需确认的 MCP elicitation 都走 DSH 原生审批。elicitation 的三个结果与 DSH 三态一一对应，同意时不携带字段值。

会话没有自由文本回答入口，所以不保留插件自有的问答面板。请求字段值的 elicitation 返回 `decline`，`item/tool/requestUserInput` 以错误结束该请求，两者都在会话里说明原因并让回合继续，不靠等待超时。不会用空答案假装用户已经确认。

没有活动 Agent、没有审批服务、断连、5 分钟未决或取消都失败关闭，并留下会话通知。

## 入口

入口是模型选择器里的 Codex 路由，不另做侧边栏按钮，也不作为 agent preset 模式。选中该路由即由 Codex adapter 处理。模型和推理档位来自本机 `model/list`，在选择器里切换；「本机配置」省略 model 和 effort，沿用本机默认。目录失败时不编造列表。插件安装过的 `dsh-codex` preset 只在所有权标记匹配时移除，未知目录不动。`codex_delegate` 创建普通可见会话并选中「本机配置」。用户显式调用的 skill 和插件说明作为文本交给 Codex，不在 DSH 再执行一次。会话列表没有公开的行图标槽，不能给每一行上色。列表标题保留问题，并加 `【codex】` 前缀区分。打开会话后，会话头另用颜色标记。`codex_delegate` 名称保留，但不再组合 one-shot 官方 provider/tool。

线程映射等必要通知仍写入会话日志，供重启后恢复。不在输入 dock 放置命令、警告或问答卡片。会话头只显示 Codex 标识和同一份账号剩余额度。

## 升级

协议客户端只实现已对照 `0.153.4` handshake 的方法。更换 `@openai/codex` 版本必须重跑 keyless handshake，并用已有登录单独验收多轮、resume 和审批。keyless 测试不能代替登录验收。市场目录在新 tarball 完成完整性校验前保持 `0.2.0`。
