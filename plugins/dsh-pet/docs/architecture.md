# Desktop Pet（桌面悬浮宠物）

> 状态：已实现（2026-09） · 平台：macOS · 目录：`plugins/dsh-pet`（自包含代码、5 个默认宠物包与通用原生 Helper）

## 背景与目标

复用内置及用户本机有权使用的 Codex 兼容宠物精灵图资源，在 DeepSeek Harness Desktop 上实现桌面悬浮宠物。插件内置 5 个默认包，另可从 `~/.codex/pets/` 读取或由用户自行放入 DSH 数据目录：

- **资源来源**：启动时先把包内 `assets/pets/` 的默认宠物、再把可选外部目录中的合法宠物幂等复制进 DSH 自己的数据目录；图片许可与 MIT 代码许可分离。
- **架构**：桌面悬浮宠物（透明、置顶、可拖拽、**原地不动**的窗口 + 头顶状态气泡），而非网页内 overlay。

## 决策

### 1. 架构形态：插件内置原生 Swift Helper（Option C，最终方案）

插件**自包含**一个原生 macOS Helper（`native/macos/`，Swift + AppKit，构建为 `.app` bundle），宿主插件通过 `child_process` 拉起它，经 **stdin/stdout 的换行 JSON 协议**通信。不需要修改 DSH 官方应用壳。

选择这一方案（替代早期"应用壳内嵌 WKWebView 面板"方案）的原因：

- **零应用壳改动**：`plugin add/install` 即可安装，无需 `dhp update` 重建官方壳；Helper 崩溃只重启 Helper，不影响宿主。
- **跨进程无鉴权耦合**：独立 Helper 进程无法共享宿主 Web 的鉴权 cookie，而 HTTP/SSE 路由需要 cookie 才能自守门。改走 stdio 协议后，状态与配置直接从宿主内存推给 Helper，彻底绕开鉴权问题。
- **原生渲染**：AppKit 原生解码 WebP（`CGImageSource`）与逐帧绘制，比 WKWebView 更轻、更稳定，动画引擎直接 1:1 移植为 Swift。

参考 `QCYTSN/dsh-dafeiyu` 的自包含插件 + 内置原生 Helper + stdio 协议的整体设计，但保留对 Codex 模板的完整兼容。

### 2. 进程与协议

- **宿主插件** `src/index.ts`：扫描/校验/复制宠物包；订阅 `agent/status`、`agent/error`、`session/event`、`user-questions/request`、`approval/request` 聚合出 `PetDisplay`（`state` 动画 + `bubble` 气泡）；拉起 Helper 并推送 `config`（宠物清单、选中项、尺寸、象限）与 `state`（状态 + 气泡）。
- **Helper**（Swift）：创建透明、置顶、非激活、跨空间的 `NSPanel`，加载精灵图、按 60fps 定时器推进帧序列，处理悬停/拖拽/朝向/右键菜单，把 `move`（拖拽结束及退出前的位置快照）与 `hide`（隐藏宠物）回传宿主持久化。
- **协议**（`src/protocol.ts` ↔ `native/macos/Sources/Protocol.swift`，`PROTOCOL_VERSION=1`）：
  - 插件 → Helper：`config`、`state`、`shutdown`。
  - Helper → 插件：`ready`、`hide`、`move {position:{x,y},positionMode:"pet-anchor"}`、`activate {sessionId}`、`closed`（`select`/`resize` 保留协议兼容但 Helper 不再发送）。
  - 每条消息 = `JSON.stringify({protocolVersion, kind, timestamp, ...payload}) + '\n'`。

### 3. 资源与数据目录

- 内置源目录 `assets/pets/` 只读且随包发布；外部源目录可配置，默认 `~/.codex/pets/`，不存在时静默跳过。
- 目标目录 `DSH_HOME/desktop-pet/packs/`（通过 `@deepseek-ai/dsh-home-paths` 的 `dshHomePath('desktop-pet','packs')` 解析），归属清晰、可重装。
- 复制幂等：按 `pet.json` 的 `id` 校验精灵图像素尺寸与 `spriteVersionNumber`；目标中没有该 id 时复制，已有同 id 内容保留，不删除未知目录。
- Helper 直接从 `packs/<id>/<spritesheetPath>` 读取精灵图（无 HTTP、无 cookie 依赖）。
- 浏览器设置卡片的缩略图则经宿主 WebServer 的两条只读回环路由（见第 7 节）读取，二者互不依赖。

### 4. 状态映射（DSH → 宠物）

参考 Codex 桌面宠物的任务状态语义（Running / Needs input / Ready / Blocked），宠物**原地不动**，通过**精灵动画 + 头顶任务列表**表达各并发任务的"工作中 / 等待确认 / 待查看 / 阻塞"阶段。`PetStatusTracker`（`src/status.ts`）把 agent/会话事件按会话归约为 `PetDisplay{state, bubble, tasks}`，随每次变更推送 `state`（含 `bubble` 与 `tasks`）。

**任务动态卡**（`tasks`）是状态展示的主体：每个活跃会话各占一张三层信息卡（`PetTask{id, title, state, stage, summary, detail, action}`），按 Codex 优先级 `Needs input > Blocked > Ready > Running` 排序（同级按最近更新时间倒序）。标题优先取本轮直接用户消息，随后才回退到当前 todo、project 和会话 id；因此 todo 变化时，用户能识别的任务名称保持稳定，也不会再出现“项目名在标题和详情重复”的情况。摘要回答“现在具体在做什么 / 为什么停住”，元信息展示项目、todo 步骤和已运行/等待/完成/出错时长，动作明确为“查看进度 / 去处理 / 查看结果 / 查看原因”。空闲时不渲染常驻气泡，避免遮挡桌面；气泡只保留给短暂异常提示。

**精灵动画**（`state`）取任务列表首行的状态（即全局最高优先级），优先级对齐 Codex `Needs input > Blocked > Ready > Running`，即 `waiting > failed > review > running > idle`：

| 宠物状态 | DSH 触发 | 说明 |
| --- | --- | --- |
| `idle` | 无活动 | 待机 |
| `running` | 思考（`turn/start`/`step/start`）或工具调用（`tool/call` → `tool/result`） | 原地奔跑（**不位移**），对应 Codex Running |
| `waiting` | 等待用户输入（question/approval/blocked turn） | 站立等待，对应 Codex Needs input |
| `failed` | agent 出错（`agent/error` / `turn/end:error`） | 跌倒/阻塞，对应 Codex Blocked，持续到下一轮 |
| `review` | 回合完成且输出未读（`turn/end:completed`） | 检查/确认姿态，对应 Codex Ready，持续到用户点击查看结果或下一轮开始 |
| `waving` | 点击（未拖动） | 打招呼（瞬态） |
| `jumping` | 鼠标悬停（v1 或非朝向态） | 悬停跳起 |
| 朝向 | 光标相对宠物本体中心的角度（仅 v2、仅 idle/running/waving） | 16 方向；任务卡尺寸不参与方向计算 |

**状态摘要**由任务卡的阶段、具体摘要、元信息组成；文案直接描述系统行为，不使用“呢 / 哦 / 啦 / ～”等装饰性语气：

| 阶段（`stage`） | 触发 | 说明 |
| --- | --- | --- |
| `待命` | idle | 无任务 |
| `准备中` | `turn/start` | 新回合梳理 |
| `思考中` | `step/start` / `assistant/message` | 推理中 |
| `查找中` / `编辑中` / `验证中` / `执行中` / `处理中` | `tool/call`（按工具名分类） | search/read→查找，write/edit→编辑，test/build→验证，shell/exec→执行，其它→处理 |
| `整理中` | `tool/result` | 工具结果回传 |
| `需要确认` | `user-questions/request` / `turn/end:blocked` | 需要用户回答 |
| `等待审批` | `approval/request` | 需要用户审批 |
| `已完成` | `turn/end:completed` | 对应 Codex Ready：`review` 动画持续到用户查看结果或下一轮开始 |
| `执行失败` | `agent/error` / `turn/end:error`（持续）；工具出错（脉冲） | 对应 Codex Blocked |
| `已停止` | `turn/end:aborted` / `max-tokens` / `interrupted` | 瞬态脉冲后回 idle |

运行时每 10 秒刷新一次耗时文本。需要用户回答时显示实际问题，等待审批时显示审批原因或工具名，执行失败时优先显示经过长度限制的真实错误信息；如果事件不含具体内容才使用兜底文案。

### 5. 动画引擎与精灵图契约（解码自 ChatGPT）

- **v2**（`spriteVersionNumber: 2`）：1536×2288，8 列 × 11 行，`requiredFramesByRow [6,8,8,4,5,8,6,6,6,8,8]`（第 9、10 行为朝向帧）。
- **v1**（省略该字段，缺省 `spriteVersionNumber ?? 1`）：1536×1872，8 列 × 9 行，`[6,8,8,4,5,8,6,6,6]`。
- atlas 按**像素尺寸**选择（1536×1872→v1，1536×2288→v2），版本→行数映射 `{1:9, 2:11}`。
- 序列：静态预览 = row0 frame0；idle = `{frames: Ylo, loopStartIndex: 0}`；非 idle = 行帧 ×3 + idle 追加 → `{frames:[...r,...Ylo], loopStartIndex: r.length}`。
- 行 → 帧：`failed`(row5) 8×(140,240)、`jumping`(row4) 5×(140,280)、`review`(row8) 6×(150,280)、`running`(row7) 6×(120,220)、`waving`(row3) 4×(140,280)、`waiting`(row6) 6×(150,260)、`running-left`(row2) 8×(120,220)、`running-right`(row1) 8×(120,220)。
- 朝向：16 桶 → `{columnIndex: bucket%8, frameDurationMs: 0, rowIndex: 9+floor(bucket/8)}`；距中心 `<=1` 为 null。AppKit 为 y-up 坐标，故角度用 `atan2(dx, dy)`（区别于 CSS 原版的 `atan2(dx, -dy)`）。

引擎有**双实现**：TS（`src/shared/animation.ts`，作为可测的权威出处 + 回归测试）与 Swift（`native/macos/Sources/Animation.swift`，Helper 实际运行），二者 1:1 对齐。

### 6. 交互

- **悬停**：进入 → 瞬态 `jumping`（v2 且 idle/running/waving 时改为朝向帧）；16 方向以 `petRect`（宠物本体）而非整个可变尺寸面板为参照；离开 → 回到基础状态。显式点击触发的挥手优先于悬停朝向，光标留在宠物上也能完整看到挥手反馈。
- **拖拽与重启恢复**：从宠物本体按下后，累计位移达到 6pt 才进入拖拽，阈值内的轻微手抖仍属于点击；直接移动 NSPanel 窗口，拖拽期间按横向方向播放 `running-left`(row2)/`running-right`(row1) 跑动动画（垂直拖动缺省取右，方向反转时才重启序列）。松手后**原地停住**（不回贴边、不吸附四角），回到基础状态，并把宠物底部中心的屏幕坐标 `position:{x,y}` 连同 `positionMode:"pet-anchor"` 经 `move` 回传，持久化到 `state.json`。关闭客户端时，Helper 会在 `closed` 前再次发送当前锚点；宿主等待 Helper 输出关闭并清空有序消息队列后才结束插件，覆盖“刚拖完立刻退出”的竞态。下次启动优先从该坐标恢复；多显示器场景按保存锚点选择目标屏幕，不使用启动瞬间的主屏归属。Helper 以该锚点反算面板原点，因此任务卡出现/消失、宽度变化或宠物尺寸变化时，本体屏幕坐标不变。缺少 `positionMode` 的旧数据仍按窗口原点恢复，并在下一次拖拽或正常退出时自动迁移；初次恢复若位置超出所有当前屏幕（例如外接屏已拔出）才夹取回可见屏幕。首次启动无保存位置时落到 `startQuadrant`（默认 `bottom-end`）一角。
- **尺寸**：默认 112px（80–224，纵横比 192:208），经 Web 设置卡片的 `petSize` 字段配置（Helper 端不再提供档位菜单）。
- **点击**（未拖动）：仅宠物本体响应，原地播放 `waving` 打招呼，同时把键盘与窗口焦点交还给启动该插件的 DeepSeek Harness 客户端，保留客户端当前会话。宿主在 `config` 中传入真实父进程 `hostPid`，Helper 用 `NSRunningApplication(processIdentifier:)` 精确激活该实例，因此开发版与安装版同时运行时不会按应用名误选。任务卡与透明面板空白区域不会误触发拖拽或挥手。
- **右键菜单**：仅"隐藏宠物"一项——立即隐藏窗口并回传 `hide`，插件据此写 `enabled:false`；宠物选择与尺寸统一在 Web 设置卡片里配置。
- **任务动态卡**：显示在宠物头顶（有活跃任务时），顶部汇总“进行中 / 需要处理 / 执行失败 / 已完成”的任务数；每项分为身份行（状态点、阶段、稳定任务标题）、最多两行的具体摘要、元信息与可点击动作三层。状态点颜色按 `waiting`（琥珀）/`failed`（红）/`review`（绿）/`running`（蓝）区分，宽度限制为 320–380pt；悬停有背景反馈和手型光标，长文截断而不会撑破卡片。出现/消失只向上扩展/收缩窗口，**宠物屏幕位置保持不变**。**点击任务行即聚焦客户端并跳转到对应会话窗口**：Helper 回传 `activate {sessionId}`、激活 `hostPid` 对应的 Harness 实例，宿主存入待激活队列，浏览器侧常驻 bundle 轮询 `GET /desktop-pet/activate` 后调 `uiWorkspace.openSession(sessionId)`（详见第 7 节）；若该项为 `review`，点击同时将其标记为已查看并从卡片移除。任务行点击不再额外触发宠物挥手。无活跃任务时不显示卡片或常驻气泡。

### 7. Web 设置页配置卡片

宠物开关、选择与尺寸可在 **Web 设置页（Settings → Plugins → Plugin configuration）** 里实时配置：

- 宿主通过 `ctx.settings.installSection` 注册命名空间 `desktop-pet`，schema `{enabled, petId, petSize}`，以 cordis 配置为组合 entry（`applies: live`）。
- 浏览器侧 `dsh.client` bundle（`src/client/`，tsdown 打包为 `lib/client.js` 的 lazy-CJS 工厂）在 keyed slot `settings.plugin.item`（key=`desktop-pet`）注册一张自包含卡片，经 `ctx.settingsScope.bind` 直接读写 settings。
- 运行时权威来源：settings 用户覆盖 → 组合 entry（cordis 默认）；`state.json` 仅保留位置及其坐标语义（`position` + `positionMode`），不再存 `petId`/`petSize`。
- 卡片字段即时提交：开关 toggle 即写；`petSize`（数字，80–224）在失焦或 Enter 时提交。Helper 右键菜单的"隐藏宠物"经 `hide` 消息回写 `enabled:false`，与卡片开关一致。

**宠物选择（缩略图网格，`petId` 不再手填）**：设置卡片的宠物 ID 文本框被替换为缩略图网格——把宠物包复制进 `DSH_HOME/desktop-pet/packs/` 后，卡片即列出每个宠物的缩略图（Codex 精灵图的首帧），点选即写 `petId`，复用 Codex 的选宠方式：

- 宿主经 `ctx.webServer.register`（`@deepseek-ai/dsh-host-webserver`）暴露两条**只读、回环（127.0.0.1）**路由：`GET /desktop-pet/packs`（宠物清单 JSON，含精灵图 URL 与像素尺寸）与 `GET /desktop-pet/sprite/<id>`（精灵图 WebP 字节）。清单里的 `spriteUrl` 指向后者。路由故意放在 `/api/` 之外——`/api` 是 `dsh-client-connection` 的 RPC 命名空间，带 Host/Origin fence 与浏览器 cookie，会让缩略图 fetch 收到 401；这些只读、非敏感资产按非 index 静态资源公开即可。
- 缩略图无需服务端解码：浏览器原生解码 WebP，卡片用 CSS `background-image` + `background-size`/`background-position` 裁出首帧 cell（192×208，行 0 列 0）。
- 两条路由按"非 index 静态资源"处理（回环 + 只读 + 用户自有资产，非敏感），不要求 index 响应的浏览器鉴权；`<id>` 严格白名单（仅允许已扫描包 id）并拒绝路径穿越，再叠加 `resolve` 前缀校验后才读文件。
- 卡片在挂载时 `fetch` 清单并本地校验形状（`parsePets`），选中项即时提交到 settings，失败/空列表有兜底文案。

**任务跳转（点击任务行打开会话窗口）**：DSH 是客户端发起 RPC，宿主无「推送浏览器导航」的公开 API；`uiWorkspace.openSession(sessionId)`（`@deepseek-ai/dsh-client-ui-workspace`，与侧栏 `ctx.get("uiWorkspace")` 同一能力）是仅有的客户端侧跳转入口。因此跳转走「Helper 点击 → 宿主暂存 → 浏览器轮询消费」的一次性通道：

- Helper 点击任务行 → 回传 `activate {sessionId}` → 宿主存 `pendingActivation`。
- 宿主经 `ctx.webServer.register` 暴露 `GET /desktop-pet/activate`：有待激活会话时返回 `200 {"sessionId"}` 并**清空**（一次性消费），否则返回 `204`。
- 浏览器侧 bundle（与设置卡片同一 `dsh.client.inject`，新增 `@deepseek-ai/dsh-client-ui-workspace`）常驻 `setInterval`（500ms）轮询该路由，拿到 `sessionId` 后调 `ctx.uiWorkspace.openSession(sessionId)`。轮询在插件生命周期内运行，卸载即停止。

## 组件清单

1. **共享动画引擎 + 状态机**（纯 TS、可测试）：`src/shared/`。
2. **宿主插件**：`src/`——宠物包扫描/校验/复制（`packs.ts`）、状态聚合（`status.ts`，任务列表）、位置持久化（`state-store.ts`，`position` + `positionMode`）、settings 命名空间注册（`index.ts` 经 `installSection`）、HTTP 路由（`server.ts`，经 `ctx.webServer.register`：`/desktop-pet/packs`、`/desktop-pet/sprite`、`/desktop-pet/activate`）、协议（`protocol.ts`）、Helper 生命周期（`helper-process.ts`）、入口（`index.ts`）。
3. **原生 Helper**（Swift + AppKit）：`native/macos/`——Atlas/Animation/Protocol/PetView/PetController/main + `build.sh` → 构建产物 `lib/helper/darwin/desktop-pet-helper.app`。
4. **浏览器设置卡片**：`src/client/`（`index.ts`/`controller.ts`/`Card.tsx`/`locales.ts`/`styles.ts`）+ 共享选宠契约（`shared/picker.ts`）+ `tsdown.client.config.ts` → 打包产物 `lib/client.js`（lazy-CJS 工厂，经 `dsh.client.inject` 注入）。

## 范围与限制

- 仅 macOS（用户已确认）。
- 桌面宠物本体（精灵 + 状态 + 拖拽 + 朝向 + 尺寸 + 宠物选择）为 v1 功能；ChatGPT 的通知托盘与快捷聊天栏属于其通知系统，不纳入 v1。
- 不修改官方 DSH 源码；所有实现都位于本插件仓库。
- Helper 构建为 `arm64 + x86_64` 通用二进制，发布包可在两类 macOS 主机复用。
