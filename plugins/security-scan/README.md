# 代码安全扫描

面向 Python、Go、JavaScript/TypeScript 的 DSH 插件。扫描、Git hook 和 CLI 共用同一套逻辑；可在工作台按任务启用 Agentic AI，复用 DSH 模型进行证据复核。官方运行时保持 `0.1.5-rc.1`，未修改上游源码。

## 安装与首次扫描

新建扫描任务和从 session 调用 `security_start_scan` 时，默认同时开启依赖漏洞查询、密钥泄露检测和 Agentic AI。OSV 查询发送包名及版本；AI 使用已配置 DSH 模型处理必要的源码片段。明确要求关闭时，可在任务中取消对应开关，或传 `dependencies=false`、`secrets=false`、`agent_review=false`。已有任务保留之前保存的选择；底层规则工具、独立 CLI 和 Git hooks 仍用于显式的规则检查，不另起 AI 会话。

退出 DSH，在本仓库执行，然后重新打开 App。已有桌面版先用 `dhp update` 更新应用壳（0.2.6 起支持原生报告保存）；Web 版只需安装插件：

```sh
dhp plugin install security-scan
```

在 DSH 中选择项目并说：

> 使用 security-review 扫描当前仓库，复核候选漏洞和业务权限问题，输出 HTML 报告，把证据和修复建议保存到 JSON。

也可以说：

> 扫描 https://gitlab.example.com/team/project.git 的 main 分支，生成 HTML 安全报告。

URL 支持 HTTPS / SSH，不允许内嵌密码或 Token。使用本机现有 Git 凭据助手（macOS 包括 Keychain）和 SSH agent，但不允许命令行交互输入；不会借用市场的 OAuth token。远端仓库临时裸克隆，不 checkout、不执行项目脚本、不安装依赖，不更新用户现有工作树。Git 操作最长 120 秒，大仓库或不可达历史会明确失败。

## 独立安全扫描工作台

安装后重新打开 DSH，点击**侧边栏底部的「安全扫描」**直接进入工作台，不需要从设置入口进入。

- **扫描任务**：新建、编辑和移除任务，配置本地目录或仓库 URL、分支/提交、全量/增量/暂存区、Git 或历史报告基线、扫描方式、依赖/密钥检测开关、DSH 编辑后自动检查。保存任务不会自行扫描；使用“保存并运行”或“立即扫描”启动。
- **运行记录**：查看排队、扫描阶段、完成、覆盖不完整、失败、取消和中断状态。一次执行一个扫描，最多 10 个待完成运行（包含正在执行的）；关闭工作台后任务继续执行。任务修改只影响之后启动的运行。最多保留最近 100 次运行；记录总量超过 4 MiB 时提前淘汰较旧的已结束记录，已有 HTML/JSON 文件不会随着记录滚动删除。
- **历史报告**：查找最近的报告，在工作台内预览 HTML，下载 HTML 或 JSON。启用过 AI 的报告会列出实际模型与累计用量（如 `24.1M tok · 缓存命中 98%`）；用量来自原生会话的 token 统计，缓存命中为缓存读取占输入侧 token 的比例。未启用 AI 或模型未返回用量的旧报告不显示这两项。0.2 报告仍可打开；任务运行记录保留当时的报告目录，修改输出目录后仍可查看这些记录关联的旧报告。
- **历史清理**：运行记录中的“删除记录”仅移除已结束的记录，保留任务、报告和原生 DSH 对话；历史报告中的“删除报告”永久删除该报告的 HTML、JSON 及内含证据，并移除运行记录里的对应报告入口。两种操作均需确认，已导出的副本不受影响。排队、执行或收尾中的记录不可删除；被任务配置或活动扫描用作基线的报告，需要先调整基线并等待扫描结束。报告目录包含未知文件或符号链接时拒绝删除。
- **扫描设置**：查看 Semgrep/Gitleaks 自动安装进度和重试，配置报告目录。自定义扫描器路径、编辑工具与旧版全局开关收在高级设置。设置通过官方 provider 写入 `settings.yaml`，不需要手工编辑。

每个本地任务都有 **Git hooks** 按钮。选择提交前或推送前、安装或卸载，检查仓库和推送基线后再确认。保存任务不会悄悄修改仓库，也不会覆盖已有用户 hook 或 hooksPath。Git hooks 执行 Semgrep 规则；任务里的依赖查询、密钥检测和盘点模式不会自动带入 hook。配置这些检查时请使用手动任务或 DSH 编辑后自动任务。

按任务启用“DSH 编辑后自动检查”后，匹配该代码目录的编辑会合并触发该任务；扫描期间发生的编辑会在结束后再检查一次。不需要同时打开旧版全局开关。用户主动取消记录为“已取消”，Host 正常关闭中止的任务记录为“已中断”，再次打开后由用户决定是否重跑，不自动恢复执行。

任务定义和运行记录保存在实际 DSH 数据目录的 `security-scan/tasks.json`。任务存储使用独占锁；异常退出遗留锁时应先核实进程归属，不自动清除未知锁。移除任务保留报告、运行记录和已经安装的 Git hooks。

工作台使用官方 `sidebar.footer.action` 和 `shell.overlay` 扩展点，保留原有对话和侧边栏；“返回 DSH”回到原界面。RPC 仅通过官方 Connection 的 loopback 授权通道开放。报告在独立 sandbox iframe 中显示，不能操作外层 DSH 页面。

工作台可执行规则扫描及按任务启用的 AI 复核，也保留 DSH 会话中的 `security-review` 入口。没有扫描器时可选择“仅盘点文件”验证任务和报告流程，但这不会执行静态安全规则。

## 工作台与会话两种启动入口

- **工作台启动**：新建或编辑任务，保存并运行。新任务默认开启“同步到 DSH 会话”；仅规则扫描生成观察会话。启用 AI 时，始终在规则扫描开始前创建独立的原生执行会话，运行记录中可点击“打开会话”。
- **会话启动**：在已选择工作区的 DSH session 中说“用安全扫描插件后台扫描当前项目，并复核候选漏洞”。`security_start_scan` 创建任务并加入相同队列，直接绑定当前会话。规则扫描完成后，AI 审计排在当前轮次之后执行；启动工具返回 runId 后应结束当前回复，不要循环等待。审计工具调用、结果和报告都留在原会话，不改标题、不新建 session，使用原会话当前模型。`security_scan_status` 可查询该次运行。两种入口共用规则、审计工具、原生退出条件、校验和报告保存流程。

执行会话记录规则阶段与结果，以及原生 Agent 的模型响应、工具调用、脱敏取证结果和完成报告，不再只有观察通知。会话记录由 DSH 原生持久化管理；JSON 报告只保存审查事实和引用，不复制整份对话。AI 必须有执行会话：对话入口复用原会话，工作台入口新建会话。关闭同步不会改变这种绑定，只关闭可选进度通知或仅规则扫描的观察会话。已有任务明确保存的同步选项保持原值，新任务默认开启。

同步通知本身不额外调用模型。关闭会话界面不取消任务；可在运行记录取消，也可在执行会话中停止正在运行的 Agent。审计结束会卸载本轮临时工具与提示词，原会话可继续普通对话；后续扫描通过工作台或 `security_start_scan` 新建一次运行。同一会话不能同时绑定两个活动扫描。取消尚未执行的扫描只移除它自己的待办消息；取消正在执行的审计保留其他待办输入，后续调度遵循 DSH 原生行为。对话启动默认开启依赖漏洞、密钥泄露检测和 AI；用户明确排除的检查按参数关闭。CLI 和兼容的同步 `security_audit` 不自动创建会话。

如果结果为“覆盖不完整”，展开运行记录中的“覆盖缺口与诊断”，分别查看源码、密钥、依赖与 AI 的状态。例如文件数量上限、暂不支持的 `uv.lock`、模型请求失败或未完成候选复核属于不同原因；缩小到具体子项目后重扫，不通过提高置信度或忽略缺口来标记完成。

## 按任务启用 Agentic AI

新任务默认打开 **启用 Agentic AI**；可以编辑任务关闭或切换模型，保存后运行。工作台启动固定使用插件的 **安全审计** preset（`dsh-security-audit`）；对话入口保留原会话配置，只在审计轮次临时提供审计工具和提示词。如果当前聊天模式隐藏了扫描启动工具，请新建“安全审计”模式的会话或从工作台启动；已有非空会话的 preset 是否可切换由原生 DSH 决定。它复用官方 Shell（macOS/Linux 为 bash，Windows 为 pwsh）、文件读写、glob/grep 搜索、Skills、后台任务工具，并提供审计工具与官方上下文压缩；基础操作沿用 DSH 宿主沙箱和审批策略，审计默认不修改代码。初版不提供任意 preset 切换。每个任务的代码来源、扫描范围、基线、自动触发和 AI 模型选择分别保存；可搜索或复制已有任务，复制后先编辑再保存，不自动启动。

流程是：**代码快照 → 规则与基线 → AI 计划和取证 → 复核结论 → HTML 报告**。工作台通过官方 `ctx.agents.create()` 新建执行会话；对话入口通过已有 Agent 的 `followup()` 排队，不重建或接管会话生命周期。AI 均由原生 Agent Loop 执行。工作台默认读取 DSH 默认模型，也可在“模型选择”下拉框选择 DSH 已配置的模型，无需手填 Provider 或模型 ID。默认选择“跟随 DSH 默认模型”，可刷新模型列表；旧任务中未被列表列出的模型会保留并提示，不自动替换。插件不保存或要求另一份 API Key。启用表示允许把选取的源码片段发送给该模型，DSH 编辑后自动任务沿用这一选择。

AI 不是单次总结扫描器输出：它可以列出文件、选择审查方向、按需读取精确快照、追踪调用者和安全保护、批量复核候选并补充业务风险。执行轮次、上下文压缩、输出限制和结束由原生 DSH Agent Runtime 管理；不再叠加插件的 12 轮 / 5 分钟 / 4096 Token 限制。`finish_review` 只记录检查点，不强制结束对话。原生自然结束但仍有未复核候选时，任务显示“已结束”，同时单独标明覆盖缺口。模型失败或取消时保留已有结果，不视为安全通过。

运行记录展示实际模型、轮次、读取文件、已复核候选及操作记录；报告包含同样的审查范围和结构化引用。规则阶段仅生成私有 JSON 检查点；执行结束后发布一份最终 JSON + HTML，再显示报告入口。检查点随本次工作清理，不出现在报告列表中。任务和报告记录操作事实与结论；实际模型与工具对话保存在原生执行 session，取证内容会进入该 session。AI 只复核可取证的源码候选，依赖公告和非源码密钥发现留在规则报告并显示为源码复核范围外；候选按页读取，避免大批依赖结果挤占模型上下文。工具参数、未读引用等拒绝原因会显示在执行记录，并反馈给模型纠正；不因累计工具参数错误强制结束原生对话。

插件加载时通过官方用户 preset 扩展目录准备独立模式：通常是 `$DSH_HOME/.agent-presets/dsh-security-audit/`。它不会更改默认模式或官方预设；已有同名、被修改或不完整的目录会报冲突并保留，不能自动覆盖。删除插件不删除该目录或会话；需要清理时先确认归属。

AI 的审计工具包括计划、文件列表、候选分页、证据读取、复核提交和覆盖检查点，并可调用上述官方基础工具。基础工具读取不能替代已归档的证据引用；审计默认只读，不执行项目脚本或漏洞载荷。审计证据限制在本次快照中的非隐藏 Python/Go/JS/TS 文件；每次最多 5 个文件、每文件 200 行，不再另设累计 100 文件的审查上限，仍受实际快照和原生上下文管理约束。插件不再拼接模型历史，也不再施加旧版 512 KiB 上下文或 256 KiB 响应上限；模型请求与会话历史由原生运行时处理。DSH 当前模型、输出 Token 和执行预算仍然生效，输出上限会单独标明。同一位置和 CWE 的重复补充发现不会重复计数。确认和排除均需引用真实已读的行，修改后的源码会拒绝读取。常见凭据字面量在发送前做脱敏，但这不是识别全部敏感信息的保证；仍应选择适合该代码保密级别的 DSH 模型。

AI 结束只表示本次有界流程结束，不代表所有文件或业务链路均已覆盖，不作为安全认证。AI 不执行复现代码，修复建议需要人工判断和针对性验证。规则未覆盖的候选（例如配置文件中的密钥）可能需要在会话中进一步审查；CLI/Git hooks 保持规则执行，不自动消费模型额度。

## 短命令

在本插件仓库执行。扫描由插件自己的 CLI 提供，`dhp` 只负责定位已安装插件的 `bin`。`--target` 是待审查仓库，与插件安装目录的全局 `--dir` 分开：

```sh
# 全量：当前本地文件，包含未提交和未跟踪文件
dhp plugin exec security-scan -- scan --target /absolute/path/project

# 增量：相对显式指定目标分支的共同祖先；包含本地未提交改动
dhp plugin exec security-scan -- scan --target /absolute/path/project --scope diff --base origin/main

# 暂存区：读取 Git index，不混入未暂存修改
dhp plugin exec security-scan -- scan --target /absolute/path/project --scope staged

# 远端指定分支/提交
dhp plugin exec security-scan -- scan --url https://gitlab.example.com/team/project.git --ref main

# 全量扫描，使用历史报告作为基线，页面默认只看新增
dhp plugin exec security-scan -- scan --target /absolute/path/project --baseline /path/report.json --view new

# 全量扫描指定提交，并与另一个提交比较
dhp plugin exec security-scan -- scan --target /absolute/path/project --ref HEAD --base HEAD~1

# 自定义输出目录；每次创建新的扫描编号，不覆盖历史
dhp plugin exec security-scan -- scan --target /absolute/path/project --output /absolute/path/reports
```

未指定 `--target` 时扫描当前目录。旧的独立安装在 `plugin` 前加全局参数 `--dir /installation/path`。命令运行**已安装的发布包**，不隐式编译开发源码。

`--scope full|diff|staged` 控制范围；`--view all|new` 只控制页面初始筛选，JSON 始终保留全部发现。`--base` 使用 Git 重新扫描基线；`--baseline` 使用以前的 JSON，两者互斥。`--scope diff` 需要 `--base`，不猜测目标分支。新增判断要求仓库、规则、引擎配置、扫描覆盖可比较；否则显示“未比较”。位置行号移动不会自动产生新问题；完全相同内容的重命名可识别。重命名同时修改、复杂跨文件关系仍需人工复核。

## 扫描器与依赖查询

**安装后首次启用插件会自动准备 Semgrep CE 1.176.1、Gitleaks 8.24.2 和独立 Python 3.13.7，无需预装 Python、pipx 或扫描器。** CLI 首次扫描也会自动准备；只做盘点且未开启密钥检查时无需下载。扫描任务等待准备完成，失败时可在「安全扫描 → 扫描设置」查看状态并重试。

工具保存在 `~/.dsh/security-scan/toolchains/`（跟随 `DSH_HOME`），与系统环境隔离。重复启动复用已验证版本；不会改 PATH、Homebrew、系统 Python 或用户配置。自动下载需要访问 GitHub Releases 和 PyPI；不上传代码。当前支持 macOS arm64/x64、Linux glibc ≥ 2.34 arm64/x64 的发布资产，真实安装及扫描已在 macOS arm64 验证，其他平台尚未实机验收。

插件包携带安装清单和依赖锁，而不是把所有平台二进制塞入 npm 包。uv 0.8.22、Gitleaks 的官方发布包按内置 SHA-256 校验；uv 使用其内置的 Python 发布校验信息，Semgrep 及依赖只接受锁文件中的 wheel 和 SHA-256，不运行项目安装脚本。失败只清理本次创建的目录，已有版本保留；并发安装有锁保护，不自动删除异常退出遗留的锁。

如需提前准备，运行 `dhp plugin exec security-scan -- setup`（独立安装加相同的全局 `--dir`）；对应插件 CLI 为 `dsh-security setup`。已有扫描器可在高级设置填写绝对路径，留空恢复插件管理；CLI 仍支持 `--semgrep /absolute/path/semgrep` 和 `--gitleaks /absolute/path/gitleaks` 覆盖。自定义工具仍需满足上述验证版本。

Semgrep 只用包内 12 类基础规则，关闭规则联网、指标和版本检查。不是商业跨文件分析的替代品。规则包括 shell、动态代码、反序列化、TLS、SQL 和 HTML sink；模型补充权限、租户隔离、SSRF 等业务风险。

可选密钥检测使用自动准备的 Gitleaks：

```sh
dhp plugin exec security-scan -- scan --target /path/project --secrets
```

它扫描受限文件快照（包括隐藏配置文件），不扫描 Git 历史；只使用扫描器内置规则，不执行项目配置。报告不保存匹配值或原始日志，命中仍需判断真假，不尝试使用凭据。

依赖漏洞查询使用官方 OSV API：

```sh
dhp plugin exec security-scan -- scan --target /path/project --dependencies
```

**`--dependencies` 明确允许向 OSV 发送依赖名称和版本，不发送源码。** 解析 npm package-lock v2/v3、pnpm lock v9、Go go.sum、Python requirements 精确版本；其他格式、未锁定项、超过 1000 条的依赖、分页或查询失败都标明覆盖不足。依赖可达性及合适的修复版本仍需复核，不猜测 CVE 或升级版本。

源码引擎按所选范围执行；密钥和依赖引擎启用时分析整份受限快照，因此即使依赖文件未改动，也可能发现新公告。报告分别列出各引擎状态。

工作台按钮和源码查看面板跟随 DSH 浅色 / 深色主题；主按钮使用主题配套的前景色，悬停、按下及禁用状态保持可辨识。

`submit_review` 可以只提交 `reviews` 或只提交 `findings`，未提供的列表默认为空；至少有一条结果。不接受 `null`、错误类型或缺失引用。工具输入声明与实际解析使用相同规则，参数错误会给出中文纠正提示、字段路径及期望类型，不回显参数原文。

## 中文报告与 HTML 内取证

0.9.0 起，新扫描留存限量脱敏代码片段，写入唯一 JSON 数据源并内嵌到 HTML。点击文件 / 行号直接在报告内查看扫描时的代码、高亮定位、查看原文件摘要，无需 VS Code、Cursor、运行中的 DSH 或联网。每个规则命中留存附近上下文，原生 Agent 的已读片段随最终报告归档；每份报告最多 2 MiB / 5000 个片段，每片段最多 200 行。超限与未收录位置显示缺失，不读取当前代码冒充历史快照。凭据命中文件及密钥文件整段隐藏，其他片段按常见凭据模式脱敏；不要把占位符当作安全结论。分享报告也意味着分享其中留存的代码片段，应按仓库访问范围管理。

报告正文使用中文。原生 Agent 提交的证据、修复建议和验证说明必须包含中文，否则工具反馈纠正；标识符、代码和来源原文保留。未翻译的历史结论不会被伪造为中文复核，页面明确标明缺失，原文可展开追溯。每项列出规则 / 公告编号、文件位置、复核判断与未验证项。

## 报告阅读与修复

0.8.2 起，报告首页优先展示中文处理清单：复核标记的源码风险、尚待追踪的源码、待核实凭据、需要评估升级的依赖包。依赖公告记录数不当作已证实漏洞数；同类源码风险集中展示全部位置。各引擎覆盖状态单独说明，详细英文原文、公告链接和执行日志按需展开。默认隐藏已排除项，可以在原始发现中切换筛选。

新的 AI 审查要求中文结论。取证工具隐藏了凭据原值时，不接受模型凭该占位符将其排除；保留待复核，并提示核实。旧报告中引用脱敏占位符的排除结论显示复查提示，但不悄悄改写历史 JSON 状态。

- 先看执行结论、已确认 / 待复核记录数和各引擎覆盖缺口。执行结束不代表不存在漏洞，也不代表 AI 逐文件审查了整个仓库。
- 结果按源码风险、依赖漏洞、凭据泄漏分组；依赖再按包聚合。仅基于 OSV 明确的 aliases 合并同一漏洞，不把同包的不同公告当作重复。原始记录、文件位置、不同版本和复核状态仍保存在 JSON 中。
- OSV 查询同时获取公告摘要、别名、修复版本与参考链接。修复版本可能属于不同维护分支，不能直接选“最大版本”就保证修复所有漏洞；升级约束和锁文件后应测试并复扫。详情请求失败不丢弃候选、不猜版本。
- 在 DSH 或独立 HTML 内点击文件 / 引用，优先查看留存的扫描快照；即使工作区后来改变，也不会替换已归档证据。独立 HTML 在页面内打开已留存的脱敏代码片段，远端提交同样可离线查看已归档片段。旧报告的依赖行号通常为 1，新扫描的 requirements / go.sum 提供精确行号，其他格式明确标识清单首行。
- 支持包 / 文件 / 公告搜索、风险 / 状态 / 基线 / 类型筛选、展开收起、打印 PDF。打印展开所有详情，仍尊重当前筛选。
- 任务结束后执行 session 给出结束通知与最终 HTML 链接；失败、取消和覆盖缺口不伪装成通过。

## 报告与模型复核

默认输出到实际 DSH 数据目录的 `security-scan/reports/<扫描编号>/`：

```text
report.json  # 唯一数据源：提交/快照、范围、规则、发现、证据、建议、历史比较
report.html  # 从 JSON 生成，可离线查看、筛选、展开和打印为 PDF
```

不生成 Markdown 报告。长期只需保留 JSON，HTML 可重新生成。HTML 不加载外部脚本、字体或资源；所有报告字段作为文本转义，仅 http/https 引用转换为安全链接；新窗口链接使用 noopener/noreferrer。报告包含仓库元数据和漏洞位置，分享前按项目保密要求处理。

```sh
# 列出最近报告（自动检查的报告也在这里）
dhp plugin exec security-scan -- list
dhp plugin exec security-scan -- render --report /path/report.json --output /path/new-report.html
dhp plugin exec security-scan -- render --report /path/report.json --output /path/report.sarif --format sarif
```

正常扫描统一通过 `security_start_scan` 或工作台发起。兼容工具仍可用于单次人工取证：`security_audit` 生成报告；`security_read_evidence` 读取精确快照中的代码供当前模型复核；`security_review_report` 保存确认、排除、补充发现、修复建议和验证方式，生成新的 JSON/HTML 版本，保留原报告。远端证据按记录的提交重新读取；本地工作树或 index 变化后必须重扫。复核不自动修改用户代码。要求修复时，模型可以通过 DSH 原有编辑/测试工具生成补丁和针对性测试，再重新扫描验证。

CLI 本身**不启动额外 LLM**。CLI 结果标记待复核；模型复核在 DSH 会话或工作台中按任务执行。CI 可导入已有复核 JSON：

```sh
dhp plugin exec security-scan -- review --report /path/report.json --reviews /path/reviews.json
dhp plugin exec security-scan -- check --report /path/reviewed-report.json --fail-on high
```

复核输入是数组，每项包含 `findingId`、`status`（confirmed/needs-review/dismissed）、`severity`、`evidence`、`recommendation`、`verification`、`reviewer`。未复核部分不会自动算通过；“本次未检出”不会自动算已修复。

## 可选自动检查

### Git hooks

```sh
dhp plugin exec security-scan -- hook --target /path/project --event pre-commit
dhp plugin exec security-scan -- hook --target /path/project --event pre-push --base origin/main
dhp plugin exec security-scan -- hook --target /path/project --event pre-commit --action remove
```

仅在显式安装命令后写入目标仓库的 hook。pre-push 读取 Git 提供的实际推送提交，逐个检查非删除的 ref，不混入未提交改动。默认提醒，不阻断提交。`ENFORCE=1` 可令扫描失败/不完整阻断 hook；候选发现不会冒充已确认漏洞来阻断。复核后可用 `ACTION=check FAIL_ON=high|medium` 对新增、已确认问题执行质量门禁。

已有 hook 或 `core.hooksPath` 一律保留；请将上述 scan 命令接入既有 hook 管理器，不自动覆盖或拼接未知脚本。修改本插件的 hook 选项时先 remove 再 install。钩子固定引用安装时的 CLI、Node、扫描器和报告目录，移动安装后应重新安装 hook。

### DSH 编辑后检查

在实际 DSH 的 `settings.yaml` 中配置，默认关闭：

```yaml
security-scan:
  semgrepPath: /absolute/path/to/semgrep
  gitleaksPath: /absolute/path/to/gitleaks
  autoScan: true
  hookTools: [write, edit, str_replace_editor, write_file, edit_file, apply_patch]
```

使用官方 `tools/result` 事件观察成功的指定工具调用；按工作区合并连续编辑，后台对 `HEAD` 做增量规则检查。默认覆盖官方 `write`、`edit` 和 `str_replace_editor`，并保留其他编辑插件常用别名；`str_replace_editor` 的 view 不触发。旧版显式配置了别名列表的用户，可在工作台扫描设置里补入官方名称。不监听本插件自己的工具，不递归扫描报告，不自动联网查询或启动 LLM；报告位置写入 Host 日志。无 Git 历史或扫描失败会提示重新手动检查。禁用后停止接收新任务；卸载时取消并等待已有任务。

### CI / 定期全量

统一入口也可在已准备好 DSH、插件和扫描器的 CI runner 中调用：

```sh
# PR/MR job：TARGET_BRANCH 由 CI 提供，先确保目标分支历史已获取
dhp plugin exec security-scan -- scan --target "$PROJECT_DIR" --scope diff --base "$TARGET_BRANCH" --output "$ARTIFACT_DIR/security"
# 主分支或定期 job
dhp plugin exec security-scan -- scan --target "$PROJECT_DIR" --scope full --output "$ARTIFACT_DIR/security"
```

归档 JSON/HTML；如平台支持，再导出 SARIF。调度由现有 CI 配置负责，此插件不创建系统 cron、不修改远端流水线。没有后台模型账号时，CI 只运行规则，不能将其称作已完成模型审计。

退出码：`0` 扫描完成且未触发所配置门禁；`1` 新增已确认问题超过阈值；`2` 扫描不完整、扫描器缺失/失败或输入错误。`--engine inventory` 只盘点范围，不代表安全检查通过。

## 边界与开发

临时快照限 5000 个文本文件、20000 个目录项、单文件 1 MiB、总计 64 MiB；源码分批执行，每批最多 250 个文件，遍历整份支持语言快照；不再在 1500 文件处截断。规范化报告最多保留 2000 条发现，超限明确记录。AI 暂不读取隐藏源码；二进制、符号链接、依赖/构建目录按报告说明排除。本地 Git 工作区使用 `git ls-files --cached --others --exclude-standard`，默认遵循嵌套 `.gitignore`、反向规则和 Git 标准排除规则；已跟踪文件即使匹配忽略项仍扫描。普通非 Git 目录只应用内置排除目录。提交和暂存区扫描以 Git 中记录的文件为准。不应用 `.semgrepignore` 或项目自带扫描配置；不执行子模块、项目脚本或依赖安装。超限和覆盖缺口在报告中保留。

```sh
pnpm --filter @shamcleren/dsh-security-scan typecheck
pnpm --filter @shamcleren/dsh-security-scan test
SECURITY_TEST_SEMGREP=/path/semgrep pnpm --filter @shamcleren/dsh-security-scan test
pnpm --filter @shamcleren/dsh-security-scan build
```

规则引擎真实用例未配置扫描器时明确跳过。设置 `SECURITY_TEST_INSTALLATION` 指向隔离的测试安装后，还会验证发布包经官方 profile 加载器成功合成；未设置时该项明确跳过。真实微信/模型账号、远端私有仓库权限和不同平台兼容性需要分别验收。

安全审计的基础工具与后台审计会话保持一致；基础 read/bash 可以辅助定位，最终报告引用仍需通过 read_evidence 校验扫描版本并保留脱敏片段。历史预设的声明文件不变，升级插件并重启 DSH 后加载新工具实现，无需删除或重写自定义预设配置。

## 工具校验反馈

`submit_review` 会校验整批证据，再保存结论。工具返回 `unread-citation` 表示引用范围尚未通过 `read_evidence` 完整读取；`redacted-secret` 表示不能把被隐藏的密钥直接认定为误报。这类拒绝允许模型修正后继续，不等于扫描失败。反馈用中文说明，`issues` 定位记录 ID、数组下标和文件行范围；`saved=false` 表示本批没有保存，修正后可整批或分批重交。单次最多列出 20 个问题，其余数量在 `omittedIssues` 中展示。取证结果的 `redactedLines` 明确标记隐藏行；没有原值依据时应保留待复核。
