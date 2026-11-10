# Channel 默认模型与预设

每个聊天 channel 在没有渠道覆盖时继承 DSH 全局默认，显式配置只覆盖该渠道插件自己的新会话。微信预设覆盖属于整个插件；企微多机器人模式下，工作区、模型和预设覆盖属于各自的机器人。已有会话保持创建时的预设和上次选择的模型；`/model`、`/effort` 只修改当前会话。

## 预设

`agentPreset` 省略表示跟随 `agent-presets.default`。渠道设置卡片和 `/preset` 是同一字段的两个入口：

- 卡片提供下拉框。第一项是“跟随全局默认”；选项来自 `agentPresets.list()`。不可用预设禁选并展示原因，列表不可用时明确报错，不接受手填绕过。
- `/preset` 列出清单及当前继承关系，`/preset <id>` 固定该渠道，`/preset reset` 清除覆盖。
- 写入只通过本插件 settings namespace 的 path op。`reset` 使用 `unset`，不能用整体替换丢弃命令未读取的字段。写入失败必须原样报告，不得声称切换成功。
- 切换后在当前工作区重建当前对话的会话并更新绑定；旧会话保留。预设变化不得纳入连接重建 key，否则保存回复会随连接一起断开。
- 部署没有预设注册表时，`/preset <id>` 仍可写入，但只有清单不可用。

## 模型

企微每个 `bots[]` 条目可以配置 `model: { provider, model, reasoningEffort? }`，在新会话创建后初始化。省略时新会话继承 `agent-default-model`。`/model` 和 `/effort` 只切换当前会话；`/new` 创建的新会话重新使用机器人配置的默认模型。

`sessionController.selectModel` 仍会保存部署级默认，因此 IM 渠道不调用它，也不采用先修改全局再恢复的方式。渠道通过公开的 `resolveAgent`、`llm.resolveCallConfig` 和 Agent 作用域的 `system-prompt/assemble`、`agent/request` waterfall 完成模型校验和路由，追加标准 `model/selection` 事件。每个 step 在 prompt assembly 时捕获选择，保证系统提示词与模型请求一致；插件卸载时移除监听，持久化选择由官方会话投影在恢复时接管。

企微 `/preset` 写入发送机器人对应的 `bots.<index>.agentPreset`，不会改变其他机器人；旧单机器人配置仍写顶层字段。配置索引取自提交时的稳定机器人 id，浏览器编辑同时携带 settings revision 防止旧列表覆盖新列表。
