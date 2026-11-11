# 统一 IM 工作台

工作台提供一个 `im` catalog 包和一个管理入口，平台协议作为包内适配器实现。首批整合个人微信（iLink）和企业微信智能机器人；后续飞书、Telegram 等沿用适配器注册接口，不要求用户逐个平台安装工作台插件。企业微信文档、日程等办公 Skill 属于能力包，保持独立。

参考 [Koishi 的适配器模型](https://koishi.chat/en-US/guide/adapter/)、[DSH IM Gateway](https://github.com/lijian-ui/dsh-im-gateway)、[DSH IM Connect](https://github.com/MichengAI/dsh-im-connect) 与 [OpenClaw 的渠道路由](https://docs.openclaw.ai/channels/channel-routing)。借鉴统一入口、平台能力声明和会话隔离的结构，不引入未经本项目锁定运行时验证的整套网关依赖。

公共核心负责 Host 会话接口、命令识别、错误分类和适配器注册；协议收发、二维码、平台审批表现和媒体编解码仍由适配器持有。账号、平台、聊天和会话身份保持隔离，平台功能按实际能力声明。

一个 bundle 包含 IM 核心与平台组件，沿用 `wechat`、`wecom-aibot` 配置命名空间，以及原有凭据引用、账号文件、消息游标、通知队列和会话绑定路径。旧 catalog 插件通过受保护的 profile 更新事务替换为 `im`。迁移保留平台的启停意图，不默认连接新增渠道；未安装旧 IM 插件的 profile 不自动安装新 IM。

帮助、命令提示、工作区查询等管理命令不依赖创建模型会话。已有会话通过公开 Host 接口继续使用；新建会话以 Host 实际返回的身份为准。入站媒体、Host 会话和发送失败分开报告，诊断不包含凭据与消息正文。

管理页统一平台选择、启停、状态、默认工作区和账号配置。单行表单控件统一为 40 像素，使用相同的边框、内边距和圆角；下拉框移除平台原生外观后绘制箭头，并保留原生键盘行为。验收覆盖官方插件页、Safari/WebKit 与 Chromium、中英文、深浅主题、窄窗口、禁用及焦点状态。
