# Python、Go、JS 代码安全扫描选型

调研日期：2026-09-09。市场前置验证见 [Marketplace 0.3.0 记录](../verification/marketplace-oauth-0.3.0.md)，已覆盖真实 OAuth、目录读取、原生 Host 内安装和卸载。

| 方案 | 适用范围 | 本仓库选择 |
| --- | --- | --- |
| [Semgrep CE](https://docs.semgrep.dev/semgrep-ce-languages) / [CLI](https://docs.semgrep.dev/cli-reference) | Python、Go、JS/TS 本地模式匹配和有限静态分析 | 第一版使用，固定验证 1.176.1；自有基础规则和离线调用，不使用 `--config auto` 或云端规则 |
| [OSV-Scanner](https://github.com/google/osv-scanner) | 根据依赖清单/锁文件检查已知漏洞，可另配离线库 | 后续依赖扫描补充；第一版不联网发送依赖名称/版本，不把规则扫描表述为 CVE 扫描 |
| [Trail of Bits Skills](https://github.com/trailofbits/skills) | 审计上下文、差异审查、误报复核等 LLM 工作流 | 作为流程设计参考；本插件独立编写 DSH Skill，没有复制或分发其 Skill 内容 |
| [Gitleaks](https://github.com/gitleaks/gitleaks) | 文件与 Git 历史中的秘密检测 | 后续可补充，需保持脱敏输出；第一版不宣称专用密钥扫描覆盖 |
| [DSH api-relay-audit](https://github.com/toby-bridges/api-relay-audit) | AI 中继、提示注入、工具调用改写等服务行为审计 | 与当前源码审计目标不同，不直接复用 |

采用一个独立 DSH bundle：只读工具负责文件范围、可选 Semgrep 执行及结构化候选；Skill 负责当前模型的调用链复核和补充审计。用户安装后即可使用模型审查，不以安装 Python 或商业云扫描服务作为插件启动前提。Semgrep 缺失、版本不同、错误和覆盖限制均显式呈现。

静态规则命中和确认漏洞分开。结果不携带源码行或秘密值；模型通过 DSH 现有工具按需读取上下文。扫描器不执行待审计项目，使用工作区内的有界源码快照，工具和规则由安装配置/发布包决定，不能由模型提供任意命令或外部规则地址。

不承诺 Semgrep CE 的能力等同商业跨文件分析，不承诺 LLM 零误报或完整覆盖。使用报告中的候选和缺口继续复核，而不是给出“项目绝对安全”的结论。

## 0.2 的扫描与报告架构

扫描范围（full/diff/staged）、结果筛选（all/new）和复核状态分别建模。工作树使用有界快照，暂存区直接读取 index，远端通过临时裸仓库读取提交，避免 checkout 触发过滤器或项目代码。增量扫描分析变更文件的完整内容，并扫描 Git 基线；指纹基于规则命中片段和文件归属，避免行号移动制造新问题。完全相同内容的重命名可识别。复杂重构不保证自动识别历史身份，必须保留复核状态。

每次报告独立保存 JSON，HTML/SARIF 均由它生成；复核产生新报告版本，保留原始证据。模型可以读取精确扫描版本的有限代码片段，补充业务风险，记录证据、建议与验证状态；没有后台模型账号的 CLI 和 hook 只执行规则。用户要求修复时沿用 DSH 公开编辑和测试工具，不在扫描器中隐藏自动改码。

密钥引擎适配 Gitleaks 8.24.2，使用内置规则及脱敏输出；依赖查询直接使用官方 OSV querybatch API，避免额外安装一个 CLI，且仅在显式启用时发送名称/版本。锁文件解析和查询范围均进入覆盖记录。保留可替换引擎边界，不将某个扫描器等同完整安全保证。

Git hooks 只有显式安装后生效，保留用户既有 hooks 和 hooksPath。DSH 自动扫描使用官方 tools/result 观察点，按配置的编辑工具触发，合并同一工作区的连续编辑；卸载取消并等待所有拥有的扫描。CI/定期任务通过统一 CLI 接入，不修改系统或远端流水线配置。

## 0.3 的独立工作台

安全扫描属于持续使用的任务界面，入口放在 sidebar.footer.action，工作台放在 shell.overlay；不借用 settings.plugins.tab，也不替换 conversation 单槽。工作台内管理任务、运行记录、报告和必要配置，返回后保留原对话状态。

任务持久化与扫描器分离，所有入口继续复用同一 audit 工作流。任务编辑采用 revision 检查避免覆盖其他页面的修改；运行保存配置快照，排队、取消、关闭与重新启动都有明确状态。活动记录不会被历史条数限制淘汰。文件写入串行且原子发布，使用安装拥有的独占锁；未知锁不自动删除。

浏览器 RPC 是人操作入口，与 model tools 分开。Git hook 修改必须经过具体仓库、触发点和动作的确认，不随着保存任务执行。输出目录变化后，运行仍保留原报告目录用于回看；schema v1 继续接受 0.2 和 0.3 的报告。

## 0.4 的流程与 Agentic AI

复用官方 LLM 服务而不启动拥有全部 DSH 工具的通用会话。固定流程负责快照、规则、基线和不可变报告；有界 AI 循环自主制定审查方向、选文件、取证、复核和补充业务问题。任务可以独立开关 AI、选择已有模型并设置调用/时间/输出预算。使用默认模型时在运行开始解析实际选择，运行中的模型身份保持一致。

工具权限在插件调度层强制限制，不依赖提示词承诺。所有参数经 schema 校验，证据绑定快照和已读取行，模型无法指定工作区外路径、命令、远端请求或发布操作。源码中的指令仍是审计数据。AI 结果记录实际引用、模型、操作和部分覆盖；不会记录私有推理过程，也不把失败或预算耗尽视为通过。

设计依据：NIST [SSDF 1.1](https://www.nist.gov/publications/secure-software-development-framework-ssdf-version-11-recommendations-mitigating-risk) 的 PW.7 强调通过代码审查/分析识别问题并处理发现，因此规则与复核并存、证据和后续修复建议分开留档。OWASP [AI Agent Security Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/AI_Agent_Security_Cheat_Sheet.html) 的工具最小权限、输入/输出验证、执行预算和审计记录落实为调度白名单、schema/快照检查、有界循环及元数据记录。参考这些实践不等于通过认证，也不声称免疫提示注入。

## 插件管理扫描环境（0.5.0）

首次启用由插件生命周期异步准备固定扫描器及私有 Python，CLI 首次扫描复用同一实现；不采用 npm postinstall，不修改系统依赖。发布包携带依赖锁与摘要清单。扫描等待安装完成，UI 可查看状态并重试，自定义工具路径仍可覆盖。配置与支持范围以插件 README 为准。每次安装拥有独立 generation 和排他锁，版本验证通过后原子发布 ready 标记，避免虚拟环境移动导致 shebang 失效；卸载取消并等待安装，失败仅清理本次创建的目录。

## 工作台与会话共享后台任务（0.6.0）

对话工具 security_start_scan 和工作台都进入 SecurityTasks。对话入口默认把进度写回发起 session；工作台入口按任务 syncSession 开关创建独立观察会话，默认关闭。会话由官方 ApiProxy 创建并归属工作区，生命周期由 Host 管理；插件只拥有扫描和进度发布工作，不启动第二个 Agent 执行同一审计，也不因任务结束销毁用户会话。进度作为带来源的插件 notice 持久化，报告和运行状态仍以扫描存储为准；同步失败不能抹掉扫描结果。

AI 输入仅包含可取证源码候选，依赖公告及非源码发现保留在规则报告。候选分页和范围计数避免把大批依赖记录塞进有限模型上下文；完成状态只描述实际源码复核范围。错误反馈保留安全原因码及字段路径，不回显原始模型参数、源码或凭据；权限及引用校验继续严格执行。

## 原生 Agent 与安全审计 preset（0.7.0）

替代 0.4–0.6 的插件自建模型循环。工作台和 security_start_scan 都进入同一个任务队列，AI 运行使用相同的独立原生 session，不继承发起对话的历史或工具组合。规则阶段仍由确定性工作流处理，原生 Agent 通过受限工具完成计划、候选分页、快照取证和结构化复核；任务管理器保存不可变 JSON/HTML，纯文本“完成”不能替代结果校验。

通过公开 AgentRegistry.create/setup/followup/whenIdle、ToolRuntime 和 SessionStore 组合；不修改官方运行时。执行配置固定为 dsh-security-audit preset，使用官方上下文压缩插件。rc.8 的 CLI 固定系统 preset 根目录，因此扩展使用官方支持的用户 preset 根目录；文件携带归属和内容摘要，重复加载只校验，不改默认模式、不覆盖同名未知或已修改目录。配置的详细行为和使用方式以插件 README 为准。

原生执行 session 在规则扫描前创建，阶段通知和规则结果进入该 session，实际模型/工具事件由原生循环记录。新任务默认开启通知；原会话 ID 与执行会话 ID 分开保存。AI session 不因关闭额外通知而消失。结束时撤销本次工具和监听，但保留空闲原生 session，由创建它的插件 fiber 生命周期持有；不能在结束时 dispose handle，否则官方 host/session-removed 会使客户端移除会话，无法直接打开。卸载时仍由原生所有权机制释放，已经持久化的日志保留。

不再拼接 messages 或调用 prepareCall，也不保留旧的上下文/响应字节截断。轮数、时间、模型输出上限和已读引用验证继续生效。规则引擎上限、依赖格式支持和 AI 实际取证范围是独立覆盖维度，改用原生 Agent 不意味着全仓库覆盖完成。


## 原生结束条件与报告发布（0.8.0）

0.8.0 取代上文 0.5 / 0.7 的插件调用、时间、输出预算和强制工具结束行为。原生 `turn/end` 为执行终态依据；候选覆盖单独记录。检查点工具不调用 `concludeTurn`，参数错误反馈原生 Agent 纠正，不额外计数熔断。保留逐调用参数、证据和响应大小边界。

后台规则输出为 `.runs/<runId>` 下的私有 JSON；原生执行结束后才原子发布最终 JSON + HTML。任务只在终态暴露 reportId，session 追加带来源的可读结束通知和报告链接。模型故障仍发布已有工具结果；准备阶段未得到结果则显示失败原因，不编造报告。正常收尾清理检查点；进程硬退出遗留私有检查点不作为正式报告加载。

本地工作区用 Git 标准可见文件清单构建快照，保留 tracked ignored 文件；Semgrep 按 250 文件分批，避免 1500 文件截断。快照硬上限仍显式展示具体省略文件，不伪称无界全覆盖。

报告按类型 / 依赖包分组，公告别名关系决定漏洞合并，原始发现不删除。OSV 详情来源固定为官方 API，仅传公共公告 ID；修复版本按公告记录，不推断通用安全版本。HTML 只链接 http/https；DSH 内源码通过受校验的 Connection RPC 读取，校验报告位置和扫描摘要。独立 HTML 提供明确的编辑器深链。报告 iframe 消息验证实际 frame source 和 reportId，不能借此任意读文件。

## 中文正文与离线代码依据（0.9.0）

用户要求 HTML 内完成代码位置查看后，报告从只留位置扩展为保留限量脱敏代码片段。代码片段在规则快照销毁前采集；原生 Agent 的实际已读片段随最终复核结果归档。所有片段绑定 source.files 中的原文件摘要，未知路径或摘要不一致拒绝保存。报告仍以一份 JSON 为数据源，HTML 内嵌归档片段，只用本地 DOM 展示，不请求宿主、工作区、外部站点或编辑器。限制为每报告 2 MiB、最多 5000 个片段、每片段 200 行；不完整留档明确提示。

凭据命中文件与密钥文件的归档内容整段隐藏，模型取证时也遮蔽已知凭据命中行；常见凭据模式继续脱敏。旧报告含凭据的自由文本不进入 HTML 原文追溯区，避免复核模型引用了原值后再次输出。原始 JSON 的历史内容不会静默迁移。用户分享 HTML 会同时分享非敏感代码片段，因此范围说明必须如实告知。

新的原生复核提交检查证据、建议、验证说明含中文，英文原文与技术标识仍保留用于来源核验。历史英文复核没有中文解释时明确标注，不伪造翻译或新结论。HTML 的规则 / 公告依据与复核判断分开展示，未动态验证状态保留。

## 0.10：历史清理与原生基础工具

记录与报告独立删除，保留原生 DSH 对话。报告删除先验证自有目录与身份、暂存目录，再提交引用变更；持久化失败还原。活动运行及被使用的基线不可删除。报告发布的临界阶段也受保护。

新任务和 session 启动默认开启依赖漏洞查询、密钥检测及 Agentic AI，显式排除和已保存的选择继续生效。依赖包名/版本交给 OSV，选定的源码片段由 DSH 模型处理，界面与技能说明展示该范围。

安全审计模式增加官方基础 Shell、文件读写、搜索、Skills 和后台任务工具，两种启动路径共用基础能力。通过官方工具包的公开 Config/apply 注册到预设上下文，沿用宿主文件服务、Shell、沙箱及审批；审计提示默认不修改代码。预设不再使用会遮蔽自身后代工具的三项 allow 白名单；执行器按当前 Agent 作用域获取基础工具，再限制为基础工具与本次审计工具。基础读取用于定位，报告引用仍要求 read_evidence 的版本验证与脱敏留档。预设声明文件保持不变，无需覆盖用户预设内容。

## 0.10.2：复用发起会话

对话启动保存的 sessionId 与 originSessionId 相同。原会话必须仍有存活 Agent；不存在则报错，不静默新建替代会话。规则准备完成后，通过 Agent 的公开 followup 排入同一会话；启动工具必须让当前轮次结束，避免在原轮次等待自身队列造成死锁。工作台仍创建独立安全审计会话。

借用会话使用消息 ID 和 inbox/claimed 定位所属轮次，在该消息被领取时同步挂载临时审计工具、限制与提示词，早于原生 system-prompt/tool assembly，确保第一步已声明审计工具；只等待该轮次 turn/end，不使用全 Agent whenIdle 等待其他用户工作。轮次结束同步撤销临时贡献，保留原标题、模型、preset 和生命周期。审计记录从原生 request 读取实际模型。取消待执行审计仅移除它自己的 inbox 消息，活动审计取消保留其他输入，插件不能 dispose 用户 Agent。模型故障仍保留已取得结果，报告沿用统一发布流程。

## 0.14：统一全局面板导航

取代 0.3 的底部动作和全屏浮层，使用公开的 `sidebar.panellist` 与同名 `main` 注册。侧栏按钮、折叠图标、选中状态与面板切换由官方布局负责；插件只提供本地化标签、图标和主区域工作台。报告深链在主面板注册后通过公开 `layout.selectPanel` 打开；返回会话使用 `selectPanel(null)` 或 `uiWorkspace.openSession`，不接管会话选择。

嵌入式工作台不捕获整个窗口的焦点或 Tab 键。主面板切换会卸载视图，因此未保存的任务和设置草稿由本次插件实例在内存持有；重新进入恢复草稿，显式返回并放弃修改时清除，卸载时释放。服务器上的任务和扫描生命周期不随面板卸载改变。

## Namespaced tools, lockfiles and evaluation (0.15.0)

All root and audit-session tools use the `dsh_security_scan_` prefix; the bundled Skill is `dsh-security-review`. Generic aliases are deliberately not retained because the official ToolRuntime rejects duplicate root names. Keeping an alias would preserve the collision and make behavior depend on plugin load order. Configuration, preset identity and stored data are not renamed. Migration mapping belongs to the component README.

uv.lock schema v1 is parsed as TOML rather than through regex. All locked registry versions are considered, including environment branches; local workspaces are not assumed to be public PyPI packages and VCS/archive inputs remain explicit coverage gaps. The parser never invokes uv or follows lockfile locations. OSV payloads retain only package ecosystem/name/version. Unknown schema is a coverage gap, not an empty clean result.

Versions 0.15–0.18 evaluated the deterministic engine with a packaged, independently labelled synthetic corpus that included vulnerable/fixed pairs, hard negatives and known unsupported risks. Hashes bound the baseline to labels and source bytes. The regression gate checked per-case outcomes against the same corpus and preserved existing misses/false alarms. The corpus and result were a limited measurement of candidates, not evidence of production effectiveness or AI quality. CLI evaluation never invoked a model or executed fixture code. These assets and the evaluation command were removed on 2026-11-09 because the intentionally vulnerable sources trigger repository security scanners; regression tests remain, but the package no longer provides this corpus benchmark.

The product is static source/secret/dependency scanning plus optional AI source audit. Source tracing is not dynamic application testing. Model-free operation is a supported explicit path; default AI-enabled tasks and outer AI conversations must not be advertised as zero-token.

## Runtime baseline and guided repair loop (0.16.0)

The runtime check is a bounded, read-only baseline, not a DAST engine. It runs only when the user supplies an HTTP(S) URL and explicitly authorizes it (a task checkbox; passing `--dynamic` or `dynamic_url` counts as authorization). It sends at most 12 fixed same-origin GET requests, follows same-origin redirects at most three times, ignores cross-origin redirects, caps bodies at 256 KiB, and stores neither response bodies nor cookie values. Sensitive-file probes are compared with a random missing path, so SPA fallbacks do not produce findings. Login, form submission, active payloads, crawling and authenticated scanning are intentionally excluded; they need separate authorization, rate control and target-specific configuration, which a default plugin action cannot safely assume. Integrating an external engine such as ZAP remains a later, opt-in decision.

Runtime findings use the `http` engine and an endpoint location. They are excluded from static comparability, engine-version matching and evidence capture, so adding a URL does not invalidate existing static baselines. Runtime comparison requires the same `policy.dynamic` URL and a completed earlier check. An unreachable target marks only the runtime engine failed and coverage partial; the run still succeeds with static results, and the CLI exit code remains 2.

Repair sessions receive a five-step loop (verify, minimal fix, regression test, rescan, summary) with per-category guidance. The session-scoped `dsh_security_scan_repair_rescan` tool queues one rescan of the newest report in that chain and is idempotent while a rescan is pending; the result is published back to the repair session. A rescan report can queue the next round into the same session through the public `sessionController.prompt` queue: original selections are matched by stable fingerprint, comparable added findings are included, and each round is capped at 20 items. Delivery decisions (commit, push, PR) remain in the conversation.

The editor groups source, scope/baseline, checks and repair/automation; checks are cards that state which ones need no model tokens. The report follow-up panel shows a select → repair → rescan → compare stepper, quick selections for confirmed and high-or-above findings, and a continue-repair action when a repair chain has remaining or added items.

## Standalone distribution (0.16.1)

Development stays in the GitHub `shamcleren/dsh-plugins` collection repository. The `shamcleren/dsh-security-scan` repository is a standalone distribution produced by `scripts/export-security-scan.mjs`; changes accepted there are ported back to the collection and arrive with the next export. The export rejects internal hosts, private-component references and local home paths, and removes files it exported earlier through its own manifest without touching `.git` or unknown files. The exporter, templates and standalone lockfile are maintained in the collection so that this distribution can be produced directly from GitHub.

The standalone repository commits the release `lib/` so that Git specs and dsh-plugin-hub, which fall back to `git+https://github.com/<repo>.git#<branch>` when a package is not on npm, install a runnable plugin without a build step. Its CI checks install, typecheck, tests and build, but does not diff `lib/`, because bundler output embeds checkout-dependent comments. The standalone lockfile and CI templates live in `plugins/security-scan/standalone/`, outside the package files, so the internal workspace keeps its single root lockfile.

The primary install is the GitHub Release tarball, which is byte-identical to the catalog artifact of the same version and is published with its size and SHA-256. npm is an additional channel for registry-based hubs, such as the in-DSH plugin center of dsh-plugin.org, which lists only npm packages. It must receive the same release tarball through `npm publish <tgz>`, never a repacked tree, so the registry `dist.shasum` matches the catalog and Release bytes; a version goes to npm only after its Release is published and verified. pnpm 11, which DSH uses for plugin installs, defaults to a one-day `minimumReleaseAge`, so a registry install made shortly after a publish can resolve the previous version; the Release URL stays the documented install path. The README is a short overview, and `docs/guide.md` is the behavior reference.

## User suppressions and framework rules (0.17.0)

False-positive exclusions are a per-user decision, not repository policy, so they are stored on the local machine in `security-scan/suppressions.json` next to the reports root and never written into the scanned repository. A repository-level ignore file was rejected: anyone who can commit could silently hide findings for every reviewer, and the scanner deliberately ignores project-provided configuration. The CLI and Git hooks read the same file by default so local hooks and the workbench agree; `--suppressions FILE` selects another list and `--ignore-suppressions` disables it for one run.

An exclusion matches on source identity, engine, rule, file and the stable finding fingerprint. Line shifts still match, but edited code, renamed files or another repository surface the finding again, which keeps one exclusion from hiding a later regression. AI-added findings have no cross-run identity and cannot be excluded. Matching findings become `dismissed` with a `suppression` record (id, reason, date) so the report stays auditable; they leave failure thresholds, exit codes, SARIF and AI review, and cannot receive review submissions. The store is owner-tagged, schema-validated, size-limited (5000 entries, 8 MiB), rejects symlinks, and is written under a PID lock with an atomic rename. An unreadable store never fails a scan; the report records that exclusions were not applied and the file is left untouched.

Rules grew from 12 to 29. SSRF, path traversal and open redirect use Semgrep CE intra-function taint mode with framework request sources and common guards as sanitizers; other rules remain sink patterns. Pure string literals are excluded from shell, eval, HTML and SQL sinks, because such arguments cannot carry external input. Constant variables are not resolved, and values that cross a function boundary are not followed; those remain documented limits, with AI review covering business context. The readable rule source is `scripts/build-rules.mjs`, which generates the JSON-subset `rules/baseline.yml`; a test fails when the generated file drifts.

The evaluation corpus grew from 42 to 97 cases at the same time as the rules, so the baseline was regenerated and reviewed case by case instead of being compared. The release notes report the original 42 cases separately because the new cases were written together with the new rules and are not an independent measurement. Third-party DAST remains deferred: it needs target-specific authorization, authentication and rate control that a default plugin action cannot assume.

## Previous-report baselines and conversation exclusions (0.18.0)

A task compares with its own previous report by default; the user no longer picks one. Choosing a report by hand asked for information the plugin already has, and a pinned report silently went stale as later scans ran. The baseline is resolved when a run is queued, so the run keeps a fixed comparison even if another run finishes first. Candidates are the task's successful runs, preferring complete coverage, skipping repair-branch rescans (they scan other code) and reports that can no longer be read. A task without one runs a first scan that is labelled as such instead of "no baseline". Deleting the newest report no longer has to be blocked: the next run falls back to an older one. Git baselines remain for diff scans, staged scans compare with HEAD, and "none" stays available. Tasks and runs saved by 0.17 with a pinned report are migrated on read; the pinned report becomes that run's recorded baseline.

Conversation scans previously created a new task per request, so they never had a previous report and filled the 100-task store. They now reuse one conversation-owned task per source, ref, scope and Git base. Saving such a task in the workbench removes the conversation ownership, so a conversation never overwrites a task the user edited. A scan requested while the same task is active returns the active run instead of failing.

A repair session often concludes that a finding is a false positive or not worth fixing. Recording that decision needed the workbench; the session now has `dsh_security_scan_exclude_findings`. Each call passes the official `tools/pre-execute` `ask` decision, and the DSH approval prompt lists the findings, locations and reason. The approval is the user's decision; the model is told not to ask separately and not to retry a rejected request. The preview is resolved before prompting, so unknown IDs, AI-only findings and reports outside the conversation are denied without a prompt, and a deployment without an approval channel fails closed. A conversation reaches only its repair chain, scans it started or observed, or local scans inside its workspace; IDs resolve against the newest report containing them. Exclusions share the workbench store and matching rules, and the workbench keeps manual exclusion available after a repair starts. Continuing a repair skips findings that were dismissed or excluded since the rescan.

npm becomes the primary install channel, receiving the same tarball as the GitHub Release. The documented command pins the version because pnpm 11 skips versions younger than one day unless they are named exactly; a pinned install records the exception in the profile's pnpm workspace file.
