# Codex 会话

`@shamcleren/dsh-codex-controller` 把 Codex 接成 DSH 的一种会话，而不是一次性黑盒。一个 DSH 会话对应一个可恢复的 Codex thread；回复、生成图片和审批都留在这个会话里。官方运行时保持 `0.1.6-alpha.2`，未修改上游源码。

## 怎么用

在模型选择器里选 **Codex** 就会走 Codex，不需要再切一个模式。Codex 下面可以切换模型和推理档位；目录来自本机 Codex 的 `model/list`。选「本机配置」则沿用本机默认模型和档位。目录暂时不可用时，只显示「本机配置」，不会编造模型。新会话的列表标题保留问题，并加 `【codex】` 前缀区分。侧边栏没有公开的行图标槽，不能给每一行上色。打开后，会话头另用颜色标记，并只在 Codex 会话显示剩余额度；给出重置时间时一并显示。剩余额度是账号级的一份数据，由插件大约每分钟刷新，所有 Codex 会话看到同一份。没有用量数据时不编造。不显示上下文填充百分比。输入框上方不再放活动卡片。

在普通会话里，只有人明确要求委托 Codex 时才使用 `codex_delegate`。它会新建一个可见的 Codex 会话、提交任务，并返回会话标识和首轮结果。后续追问在那个会话里进行，不会在当前对话里隐藏执行。

Codex 的登录和模型配置仍来自 Host 进程可见的本机 Codex 配置。插件不登录、不复制凭据，也不把 `CODEX_HOME` 写进 DSH 配置。

Codex app-server 完成内置 `image_gen` 后，插件会校验返回的 PNG、写入 DSH 附件存储，并作为普通 assistant 图片显示在会话中；不会伪装成 DSH 工具调用，也不会恢复输入框上方的活动卡片。是否提供内置 `image_gen` 仍由 Codex 账号、认证方式和模型能力决定；API Key、自定义 Provider 或不支持的模型可能不会暴露该工具。

DSH 用户消息中的附件都会交给 Codex。图片从附件存储解析为 Codex `turn/start` 图片输入：Host 文件存储可用时传 `localImage` 路径，其他存储后端回退为经过完整性校验的 data URL；纯图片消息同样可以启动回合。其他任意文件沿用 DSH 的通用文件投影，Codex 会收到文件名、字节数、摘要和只读保存路径，再用自己的文件工具按需读取；文件字节不会重复嵌入模型请求。是否理解图片或读取特定文件格式仍取决于当前 Codex 模型与工具能力。

## 会话与审批

映射保存在该会话的插件通知（`codex-thread:`）和插件自有记录里。DSH 不接受未声明的必需事件类型；因此不用伪造的 `codex/*` 事件充当会话日志，避免重启后会话无法加载。进程重启后用 `thread/resume` 继续同一 thread。resume 失败时会新建 thread，并在会话里说明先前线程不可用。

命令、文件和权限请求走当前 Agent 的 DSH 审批。DSH 只有单次允许、拒绝和取消，分别对应 Codex 的 `accept`、`decline` 和 `cancel`。不会发送 `acceptForSession`，也不会改写 exec policy。没有审批服务、断连、超时或取消都失败关闭。

只需确认的 MCP elicitation 也走同一条原生审批，同意时不回填任何字段值。会话没有自由文本输入口，因此请求字段值的 elicitation 直接拒绝，`item/tool/requestUserInput` 以错误结束该请求；两种情况都在会话里说明原因，不会挂起回合等到超时。空会话记录只表示“这是 Codex 会话”；没有记录、也没有切到 Codex 模式的普通会话不会显示 Codex 标识。用户用 `/skill` 或插件说明调用时，正文会交给 Codex，不会在 DSH 里再执行一遍工具。DSH 的管理工具仍由 Codex 自己的工具和 MCP 完成，不会被翻成 DSH `tool/call`。

## 边界

Codex 仍负责自己的工具、sandbox、MCP 和上下文压缩。这些活动不写成 DSH `tool/call`，也不再投影成输入框上方的卡片。标题和压缩请求不会启动 Codex turn。

隐藏思维、原始 stderr、凭据和协议噪声不展示，也不补造。未识别的公开事件不显示成卡片。

`pnpm check` 包含固定 `@openai/codex@0.153.4` 的 keyless handshake：`initialize`、`initialized`、`config/read`，不启动模型回合，也不读取用户登录。这不能代替已登录账号上的多轮和审批验收。协议基线固定在该版本；升级 Codex 包必须重新核对接线和真实会话。

发布版本与完整性校验信息以仓库的 [marketplace.json](../../marketplace.json) 为准。退出 DSH 后执行 `./dhp plugin install codex-controller` 更新到当前仓库的发布包，再重新启动 DSH。
