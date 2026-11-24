# SaaS Browser Workspace · 真实 Agent 演示

通过 DSH 原生对话操作一个已注册的服务市场：真实模型逐步观察网页、输入搜索条件、展示结果，用户选择记录后，由同一个 Agent 打开并读取配置。缺少业务参数时生成表单；登录在 DSH 内的实时页面弹框完成。右侧以原网页为主，另可查看查询和执行结果。查询结果直接显示可选记录和可展开的汇总。显式配置执行范围后，可继续完成预览调试和“去使用”的一次对话。已注册的审批页面支持逐项确认编辑、保存、发布等操作。

本组件是实验性插件，提供 catalog 安装包。它通过公开扩展点工作，没有修改 DSH 官方源码。兼容目标固定为官方 **0.2.1-rc.5 Web profile**。

## 安装到本地 DSH

先退出 DSH，在仓库执行：

```sh
git pull --ff-only
./dhp plugin install saas-browser-workspace
```

将站点规则保存到仓库外的私有 JSON 文件，在 `~/.dsh/profiles/web/cordis.patch.yml` 合并以下配置（相同 id 已存在时更新原条目的 config，保留其他字段）：

```yaml
- id: saas-browser-runtime
  config:
    enabled: true
    channel: chrome
    headless: true
    automationMode: standard
- id: saas-browser-workspace
  config:
    siteFile: /absolute/private/site.json
    executionStateDir: /absolute/private/saas-execution-state
```

如果 profile 已启用 `@anweat/dsh-browser`，保留原来的 `browser` 条目，将上面的 `saas-browser-runtime` 条目设为 `disabled: true`，避免重复注册浏览器服务。

需要本机已安装 Chrome。然后执行 `./dhp restart`，在新会话选择获准处理该站点数据的模型，输入查询任务。首次调用工作台工具会打开右侧面板，登录在弹出的原网页中完成。模型复用 DSH 中已有配置；只有下方独立 demo 需要额外的模型路由文件。此安装不会自动配置站点或导入 Cookie，也不保证自动限制会话内其他已安装工具；受限验收请使用下面仅开放三个工作台工具的独立 demo。

首次安装使用 `plugin install`；已安装用户后续执行 `./dhp update` 获取 catalog 更新。未配置站点时面板明确提示缺少配置，不会访问默认网站。

## 启动独立演示

准备两个仓库外、仅本人可读的配置文件，然后在仓库根目录运行：

```sh
pnpm --filter @shamcleren/dsh-saas-browser-workspace run build
DSH_SAAS_SITE_CONFIG=/absolute/private/site.json \
DSH_SAAS_MODEL_CONFIG=/absolute/private/model.json \
DSH_SAAS_PROMPT='查询初始化相关的智能体，让我选择一个查看配置。' \
  pnpm --filter @shamcleren/dsh-saas-browser-workspace run demo
```

启动器打包并通过官方 CLI 安装到独立临时 profile。控制台输出本机地址、会话和私有 `ready.json` 路径；后者包含 owner 访问链接，不可分享。进入“未分组”中的“查询与配置查看”会话。Ctrl+C 停止本次演示，临时目录保留供审查。

演示使用配置文件指定的真实 DSH 模型适配器，没有固定回复或预先生成的工具调用。模型决定浏览器动作和要展示的内容；站点选择器、导航与消息执行范围由宿主配置。启动器不会自动导入已有浏览器 Cookie。macOS 使用已安装 Chrome 的独立无头上下文，画面和输入在 DSH 弹框内传输。

同一任务调试重启时，可显式设置 `DSH_SAAS_BROWSER_STATE=/absolute/private/browser-state.json`，由社区浏览器服务读取已有 Playwright 登录态文件。该文件必须保持私有，不进入源码、模型输入或日志；这不会恢复旧的任务与会话状态。

模型路由文件包含 `provider`、`model` 和原生 `llm-pi-ai` 的 provider `config`（包括 `baseURL`、`models`、`apiKeyEnv` 等）。需要凭据时，`credentialFile` 指向已有 DSH credentials 文件；仅导入 `apiKeyEnv` 指定的引用，通过专用 credentials 服务使用。不允许内联 `apiKey` 或自定义认证 headers。只有明确获准的模型目的地才应处理真实站点数据。

## 完整交互

1. 在对话中描述查询任务。关键词已提供时直接使用；确实缺参时，Agent 调用 `saas_ask` 生成业务表单，支持单行和多行输入。必填项未填写时不能提交；全部为可选项时可直接跳过。
2. Agent 用 `saas_browser` 观察网页上的控件和记录，并逐步填写、搜索。每次动作产生新的观察标识，过期控件引用会被拒绝。
3. 遇到登录跳转，暂停 Agent 并在当前 DSH 会话弹出同一浏览器的实时页面。用户在原始登录页输入，完成后点“交还 Agent 并继续”。
4. Agent 调用 `saas_present` 将读取到的记录显示在“查询结果”，点击“汇总”可查看各类型数量。当前会话保留最近一次查询结果、已读取配置和执行结果，进入配置后仍可切回查询结果；来源、读取时间和统计范围始终可查。
5. 点击某条记录的“查看配置”，通过原生会话队列把选择交还 Agent。卡片没有配置按钮时，选择仍可提交；Agent 从已观察到的开发或管理入口查找同名记录，再打开配置并展示字段和可见内容。
6. 请求调试或去使用时，Agent 观察注册聊天区域，缺少消息内容则生成补参表单。填写后由同一会话继续；输入只进入消息框，发送使用唯一请求标识。同一标识不会再次发送。
7. “去使用”可接续实际按钮打开的新窗口。只在该次导航中允许一个匹配执行配置的窗口；后续重定向仍经过来源策略。
8. 发送后右侧展示执行状态、输入、原页面回复与来源。Agent 用 `wait` / `observe` 等待网页证据，分别保留调试与使用结果；不会把点击发送或用户消息回显当作完成。
9. “原网页”显示当前会话的浏览器，可在侧栏接管、交还或放大。业务页面的只读控件可直接操作，已注册页面上的其他可识别点击会生成确认卡；执行消息走 Agent 的受限工具。

表单、选择和交还都回到原会话。提交后显示排队或执行状态，前后端共同防止快速重复点击；入队失败保留原表单。接管浏览器后若仍有待填表单，交还时恢复该表单。模型仅文字回复、取消或失败时也会结束等待；模型鉴权过期单独提示恢复登录。连接中断时保留已有结果并暂停操作，可重新连接；原页面画面中断后也停止接收输入。

它们不会执行一条写死的端到端网站配方。默认允许搜索、原生折叠以及返回与查看配置等导航。调试和使用通过 `execution` 单独登记。配置变更通过下方的逐项确认流程开放。聊天会产生网站自身的对话记录，并可能消耗目标智能体额度。

## 原网页分屏（0.6.0）

侧栏默认打开原网页。查询与执行结果仍可从同一工作台切回。接管后可在侧栏滚动、操作已知导航控件，或触发已注册页面的审批。分屏尺寸改变时浏览器重新排版；普通交还时恢复默认桌面尺寸，供 Agent 继续使用桌面控件。登录仍会弹出同一网页，支持输入和粘贴。

- Chromium 在页面绘制时通过 CDP 推送 JPEG 帧，侧栏与放大视图共享推送。每个浏览器只保留最新待发画面；接收方只保留最新待绘制画面。空闲时发送保活信号，关闭最后一个视图后停止采集。
- 滚轮按网页坐标转发并合并待发送增量。切换页面、改变尺寸或断线时暂停旧画面的输入，直到收到新的画面。直播流仅供当前 DSH owner，不进入模型或历史。审批保留独立的固定证据截图。
- 页面 DOM/ARIA 继续用于 Agent 识别控件和阅读内容。用户直接看到原网页。各站点仍需注册允许的来源和操作范围。

仅查看 HTML 页面时可以省略 `selectors` 与 `emptyText`，例如：

```json
{
  "name": "业务门户",
  "url": "https://portal.example.com/",
  "allowedOrigins": ["https://portal.example.com"],
  "screenshotMasks": []
}
```

此配置启用观察和原页面展示，不启用搜索、记录选择或消息发送。需要这些能力时再按实际站点补充下面的选择器和执行规则。

## 站点配置

```json
{
  "name": "服务市场",
  "url": "https://portal.example.com/service-market/agent",
  "allowedOrigins": ["https://portal.example.com", "https://login.example.com"],
  "blockedHosts": [],
  "loginPaths": ["/login"],
  "navigationPaths": ["/development"],
  "navigationQueryKeys": ["space"],
  "selectors": {
    "search": ".div-input[contenteditable=\"true\"]",
    "results": ".g-resource-list",
    "card": ".resource-card-home",
    "name": ".resource-card-name",
    "type": ".agent-type",
    "version": ".resource-version",
    "tags": ".tag-home:not(.tag-list)",
    "description": ".resource-card-description"
  },
  "emptyText": "暂无智能体",
  "screenshotMasks": []
}
```

允许来源必须精确包含协议、域名和端口；禁止域名及其子域名优先拒绝。企业站点把登录导航重定向到 HTTP 时，仅对 GET 页面导航，在发送请求前以本地 307 转到**同域且已授权的 HTTPS 来源**。保留登录路径与回跳参数，不放行明文 HTTP、不新增域名、不关闭 TLS 校验。原生浏览器与旧 MCP 适配器共用这套来源判断。不能升级的来源继续被拦截，并在面板显示其 origin，不显示授权码或完整登录 URL。

`loginPaths` 用于登记业务站点自身的登录路径（精确 pathname），这些页面只交给用户操作，不进入模型观察。独立登录来源仍需登记在 `allowedOrigins` 中。

会话里指定空间地址时，Agent 可把它交给 `open.url`；只接受业务站点同源、`navigationPaths` 列出的页面路径，以及 `navigationQueryKeys` 列出的参数。外站、凭据、fragment、其他路径和额外参数会被拒绝。这些配置应来自实际观察的只读页面，不应覆盖业务 API 或写操作入口。

可选 `execution` 为最多两个规则的数组，分别使用 `mode: "debug"` 和 `mode: "use"`。每条规则包含精确 `origin`、`paths`，以及 `scope`（聊天容器）、`input`、`submit`、`output`、`busy`、`error` 的 CSS 选择器。来源必须已在 `allowedOrigins` 中；页面路径和消息控件均在动作执行时校验。未配置时不提供发送能力。规则来自实际页面观察，不由模型生成或修改。使用页面需登记实际首次入口和最终聊天路径；初始 HTTP 入口会先尝试升级为已授权的同域 HTTPS，再校验路径。`allowedOrigins` 还需包含实际依赖的业务 API 网关，不能只登记网页和登录来源。

`submit` 必须携带本次发送的 `request_id`、最新 `observation_id` 和发送控件 `ref`。发送前先记录收据，网络异常不自动重试；完成条件是本次新增的回复内容且没有运行状态，页面错误单独展示。等待超时或页面离开标记为待确认，不伪装成功。每会话最多 20 次提交。可配置 `executionStateDir`（或 `DSH_SAAS_STATE_DIR`）保存按会话与站点隔离的执行收据；demo 默认写入自己的私有临时目录。发送前持久化收据，恢复时保留完成结果，把未确认的执行标记为待确认，禁止自动重发。凭据和浏览器画面不写入收据。

### 逐项确认网页操作（0.5.0）

在站点 JSON 中添加 `"approvalPaths": ["/agents/config"]`，登记与入口同源的精确页面路径。未登记的页面沿用原有权限。`approvalPaths` 和消息发送的 `execution` 分开配置。

- Agent 根据观察识别可操作的控件。原生折叠和已知导航直接执行，编辑、保存、发布或用途未判明的控件先出现确认卡。对话中的“同意”不会代替按钮。
- 确认卡展示目标控件、页面地址、操作前截图和可读参数。截图可放大，填写和选择会显示当前值及拟设置值。截图和控件引用只保存在当前会话内存，五分钟过期。
- 确认只对这一个操作有效。服务端执行前复查页面地址、控件身份及已读取参数，页面变化时要求重新发起。取消不发送动作，重复确认不会重复执行。执行后 Agent 重新观察页面核对结果。
- 支持已观察到的按钮、链接、选项和普通字段。敏感字段、文件上传和任意脚本或直接 API 调用不通过此流程开放。自定义控件有可识别语义时会出现在观察中。页面原有数据读取上限和来源规则继续适用。

`selectors` 仍是站点适配配置，不代表任意网站自动发现。最多读取当前 DOM 的 50 张记录和有限可见内容，统计只覆盖这些记录。`screenshotMasks` 是显式遮挡区域的 CSS 选择器：旧静态截图路径使用它遮挡截图，当前真实 Agent 路径用它过滤观察内容，并在确认截图中遮挡这些区域和已识别的敏感字段。实时原页面画面仅提供给本机 owner，当前不应用这些遮挡，不能将其作为已脱敏截图对外分享。

## 实际复用结果

| 候选 / 组件 | 实际结论 |
| --- | --- |
| `@try-works/dsh-browser-agent@0.6.0` | 官方 CLI 在隔离 rc.5 profile 中拒绝安装，其宿主依赖要求为旧版本；未启用兼容性豁免，不宣称已接管成功。 |
| `@anweat/dsh-browser@0.2.3` | 已通过官方 CLI 安装与启动，当前复用其公开 `BrowserService` 管理浏览器会话；版本锁定。 |
| `@changfenhuang/dsh-genui@0.16.0/embed` | 复用业务补参表单；查询记录和页面内容绑定真实观察结果与会话动作。 |
| DSH 公开扩展点 | 原生模型适配器、`defineTool`、会话队列、右侧面板、工具卡、`shell.overlay`、鉴权 HTTP/RPC。 |
| 本插件补齐 | 受限观察/动作、来源与重定向策略、实时 JPEG 画面及输入传输、人工接管、结果选择及业务视图。 |

实时接管 UI 由本插件实现；不能把它描述成直接装上社区插件便已有完整体验。模型只看到三个工作台工具：`saas_browser`、`saas_present`、`saas_ask`。演示 profile 将 Agent 工具限制到这三个入口。社区浏览器服务的公开接口只在这些入口背后使用。

## 范围与边界

- 一个注册站点、独立会话浏览器、一个本机操作者；未实现多站点目录、共享账号、完整任务重启恢复或生产级登录态管理。
- 最近查询、已读配置、页面观察和补参状态仍在内存中；这不是可跨重启的查询历史库。执行收据可恢复，但不承诺恢复浏览器现场、未提交表单或整个未完成任务。
- 当前实时画面是视口 JPEG 的连续刷新，支持点击、键盘和滚动；不是完整远程桌面，也没有文件上传、下载和复杂桌面控件适配。
- 登录页面不交给模型观察；模型不接收实时画面或登录输入。业务观察过滤已识别的密码/密钥控件和显式遮挡区域，动作前再次校验控件身份和权限。复杂页面仍须核对敏感信息识别，不能承诺任意页面完全脱敏。
- 表格与配置数据来源于网页观察；模型选择展示类型，不能执行任意生成的 HTML/JS；执行结果直接来自注册输出区域的 DOM。
- 搜索和配置导航仍有站点约束。新窗口只接续注册的使用页面；复杂编辑器、分页和其他网站仍需分别验证。执行结果判断依赖该站点输出、运行和错误控件的选择器。
- origin 拦截、服务工作线程限制和 WebSocket 关闭不等于操作系统网络沙箱。控件范围限制也不能证明站点自身脚本没有副作用。
- 提供实验性 catalog 包，沿用已安装的官方宿主与 macOS 应用壳；旧配方源码与测试保留作接入历史，`demo` 已切换为真实模型入口。

## 验证

```sh
pnpm --filter @shamcleren/dsh-saas-browser-workspace run typecheck
pnpm --filter @shamcleren/dsh-saas-browser-workspace test
pnpm --filter @shamcleren/dsh-saas-browser-workspace run build
DSH_SAAS_MODEL_CONFIG=/absolute/private/model.json \
  pnpm --filter @shamcleren/dsh-saas-browser-workspace run test:smoke
```

单元及真实 Chromium 测试覆盖查询、过期控件、只读配置、敏感字段过滤、越界重定向及两套后端的 HTTP → HTTPS 登录导航；也覆盖表单并发、队列失败、接管续跑、视图保留、收据写入失败、执行区域消失、断连恢复和模型错误。界面测试加载实际 React 面板与 GenUI 表单，验证 400px 侧栏、多行输入、必填约束、可选跳过和原页面弹框；其数据和远程调用为合成夹具，不能替代完整宿主的真实模型验收。TLS 回归仅在测试浏览器信任当次临时证书的精确公钥，生产启动不使用该设置。

`test:smoke` 安装真实 tarball 到独立官方 profile，使用配置的真实模型完成本地测试站点上的表单补参、查询、用户选择、配置展示、调试及去使用，特意让市场卡片没有配置按钮，要求 Agent 自行进入开发页继续；同时验证每种模式只发送一次真实测试请求、DOM 回复为计算结果、保存次数为零，以及画面鉴权和会话隔离。没有模型配置时明确失败，不退回固定流程驱动器。本地测试不能替代真实账号与真实配置页验收。

已在一个真实站点完成补参表单、指定空间查询、界面选择和配置只读查看，使用真实 Grok 路由；表格、列表、汇总和原页面画面经过界面验收，上次保存时间经复读核对未变。也验证了该空间内的真实空结果。配置读取覆盖当前可见字段，复杂编辑器正文尚未验证；这些是本轮可用性修订前的真实站点结果。本轮已改为在当前会话保留最近查询与已读配置；尚未验证本轮候选在真实站点上的完整流程。查询阶段范围见 [0.2.0 验收记录](../../docs/verification/saas-browser-workspace-0.2.0.md)，调试与使用见 [0.3.0 验收记录](../../docs/verification/saas-browser-workspace-0.3.0.md)。

2026-11-23 可用性复评：54 项测试、构建与类型检查通过。模型登录恢复后，真实 Grok 在隔离的官方 Web profile 中完成“补参→查询→选择→配置→调试→去使用”；两次测试消息分别只发送一次，页面结果均为 `42`，保存次数为零。鉴权过期的异常提示也经过单独验证。使用本地合成测试站点，没有执行真实业务配置写入；本轮修订后的真实企业站点仍需用户本地试用。缺陷、基线证据及未验证项见 [本轮评审记录](../../docs/verification/saas-browser-workspace-review-2026-11-23.md)。

验收 catalog 中的确切发布包时，在 smoke 命令前增加 `DSH_SAAS_ARTIFACT=/absolute/path/to/catalog-package.tgz`。启动器会将该文件通过官方 CLI 安装到临时 profile，不重新打包源码。

通用 Panel 的实现与验证范围见 [0.4.2 验收记录](../../docs/verification/saas-browser-workspace-0.4.2.md)。
