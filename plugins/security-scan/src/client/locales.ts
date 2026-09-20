export const zh = {
  emptySubmission: '未提供复核或新增结果；仅查看进度请使用覆盖检查点。',
  chineseRequired: '请用中文填写依据、修复建议和验证情况，保留原始标识及未验证说明。',
  redactedSecret: '凭据已被工具脱敏，不能据此排除风险；请保留待复核并核实原始值。',
  sourcePreview: '扫描源码位置', closeSource: '关闭源码', sourceUnavailable: '无法读取扫描时的源码：文件可能已变化、删除或仓库不可用，请重新扫描。',
  nativeCompleted: 'Agent 执行已完成', nativeStopped: 'Agent 执行已停止，请查看结束原因', coveragePartial: '扫描覆盖存在缺口，请查看报告中的未覆盖原因。', resultConfirmed: '已确认', resultPending: '待复核', resultDismissed: '已排除', agentRounds: '轮',
  agentPreset: '执行模式：安全审计（基础工具＋审计工具＋上下文压缩）', agentPresetHint: '工作台启动时创建安全审计会话；从对话启动时，在原会话后续轮次审计，保留原模型和会话配置。', agentPresetMissing: '安全审计模式不可用，请检查 preset 扩展目录及同名文件是否冲突。',
  scanReportNotice: '安全扫描 · 报告与执行结果',
  agentOutputLimit: '模型单次输出达到 token 上限',
  syncSession: '同步到 DSH 会话', syncSessionHint: '从对话启动会复用原会话；工作台 AI 扫描创建执行会话。此选项控制仅规则扫描的观察会话和额外进度通知。', openSession: '打开会话', conversationTrigger: '会话发起', coverageDetails: '覆盖缺口与诊断', sessionUnavailable: '会话同步不可用或写入失败；扫描继续，请在运行记录查看结果。',
  invalidArguments: '模型工具参数不符合格式，已反馈具体字段供纠正。', unreadCitation: '引用包含未读取的行，需要先补充取证。', citationRequired: '引用未覆盖问题所在行。', sourceOnly: '该文件不在可复核源码范围内；依赖和非源码发现保留在规则报告。', readBudget: '读取内容过大，需要减少文件或行数。', sourceChanged: '代码已在扫描后变化，需要重新扫描。', unknownFinding: '候选编号不在本次源码复核列表中。', planRequired: '需要先提交审查计划。', planStarted: '已有审查计划，应继续取证或提交结论。', unsupportedTool: '请求了未开放的工具或错误的结束顺序。',

  enginesTitle: '扫描环境', engineReady: '已就绪', engineInstalling: '正在准备', engineFailed: '准备失败', engineIdle: '尚未准备', engineRetry: '准备 / 重试',
  managedDefault: '由插件自动管理', engineOverrides: '高级设置', overrideHint: '留空使用插件内置版本；如需使用已有工具，可填写绝对路径。自定义工具仍须满足已验证版本。',
  semgrepPurpose: 'Python、Go、JS / TS 代码规则', gitleaksPurpose: '检测意外提交的密钥', viewEnvironment: '查看扫描环境',
  engineChecking: '检查已安装版本', engineDownload: '下载并校验运行工具', enginePython: '准备独立 Python 环境', engineSemgrep: '安装锁定的 Semgrep 依赖', engineGitleaks: '下载并校验 Gitleaks',
  engineFailureHint: '请检查网络、目录权限与可用空间，然后重试。自定义路径不受影响。', engineLockHint: '另一个安装进程持有锁；等待它完成后重试。异常退出留下的锁需先核实归属。', engineUnsupportedHint: '此平台暂不支持自动安装，可在高级设置中配置已有扫描器。', engineIntegrityHint: '安装包完整性校验失败，未执行该文件；请检查下载来源后重试。',
  sourceSection: '代码来源', policySection: '扫描策略', taskIntro: '为每个仓库保存扫描范围、基线和自动检查策略。',

  rulesReport: '原始规则报告', agentAdditional: '补充发现', copySuffix: '（副本）',
  agentModelMissing: '尚未配置 DSH 默认模型', agentStepLimit: '已达到调用轮次限制', agentTimeLimit: '已达到运行时限', agentContextLimit: '上下文或输出超出预算', agentModelFailed: '模型请求失败，请检查 DSH 模型配置', agentInvalid: '模型未能返回有效工具调用', agentEvidenceMissing: '部分候选缺少可复核的源码证据',
  agent: 'AI 证据复核', agentEnable: '启用 Agentic AI', agentHint: '规则扫描后由 DSH 模型自主选取证据、追踪风险并生成建议。选中的源码会发送给该模型；自动检查也使用此配置。',
  agentDefault: '跟随 DSH 默认模型', agentAdvanced: '模型选择', agentModelsLoading: '正在加载模型…', agentModelsRefresh: '刷新模型', agentModelsHint: '来自 DSH 已配置的模型；选择默认项会跟随 DSH 默认模型变化。', agentModelsEmpty: '暂无可选模型，请先在 DSH 模型设置中配置，再刷新列表。', agentModelsFailed: '部分模型列表加载失败，可重试刷新；已保存的选择仍会保留。', agentSavedModel: '已保存，未在列表中', agentSavedModelHint: '该模型未在当前列表中，可能未被列出或配置已移除。保留原选择；运行前请核实 DSH 模型配置。',
  agentSteps: '最多模型调用轮次', agentMinutes: '最长运行分钟数', agentTokens: '每轮最大输出 Token', agentBudget: '退出、输出上限和上下文管理沿用 DSH 原生运行时，插件不设置额外轮数或时限。',
  flow: '代码快照 → 规则与基线 → AI 证据复核 → HTML 报告', agentDetails: 'AI 执行记录', agentRound: '模型调用', agentFiles: '已读取文件', agentReviewed: '已复核候选',
  listing: '发现代码文件', planning: '确定审查范围', reading: '读取快照证据', reviewing: '保存复核结论', rejected: '拒绝无效操作', agentIncomplete: 'AI 复核未完成', agentCompleted: 'AI 流程已结束（非安全认证）',
  duplicate: '复制任务', taskSearch: '搜索任务或仓库', noTaskMatch: '没有匹配的任务',

  entry: '安全扫描', title: '安全扫描工作台', subtitle: '管理代码审查任务、自动检查和扫描报告', back: '返回 DSH',
  tasks: '扫描任务', runs: '运行记录', settings: '扫描设置', reports: '历史报告', newTask: '新建任务', refresh: '刷新', loading: '正在加载…',
  emptyTasks: '还没有扫描任务', emptyTasksHint: '添加本地代码目录或仓库地址，保存后可以随时运行。', emptyRuns: '暂无运行记录', emptyReports: '暂无报告',
  name: '任务名称', kind: '代码来源', local: '本地目录', remote: '仓库地址', target: '目录或仓库地址', localHint: '填写代码目录的绝对路径', remoteHint: 'HTTPS 或 SSH 地址，使用本机 Git 授权；不要填写 Token 或密码',
  ref: '分支或提交（可选）', refHint: '本地留空扫描工作区文件；远端留空使用默认分支。', scope: '扫描范围', full: '全量', diff: '增量', staged: '暂存区',
  stagedHint: '读取 Git 暂存区，与 HEAD 比较，不包含未暂存的修改。', baseline: '比较基线', none: '不比较', git: 'Git 分支 / 提交', report: '历史报告',
  base: '基线分支或提交', baseHint: '增量扫描使用它与当前提交的共同祖先。', baselineId: '选择历史报告', selectReport: '请选择报告',
  engine: '扫描方式', auto: '静态规则扫描', inventory: '仅盘点文件（不执行安全规则）',
  dependencies: '查询依赖漏洞', dependenciesHint: '启用后向官方 OSV 发送依赖名称和版本，不发送源码。', secrets: '检测泄漏密钥', secretsHint: '插件自动准备 Gitleaks；报告只保留脱敏位置。',
  view: '报告初始筛选', all: '全部问题', new: '新增问题', autoScan: 'DSH 编辑后自动检查', autoHint: '观察扫描设置中的编辑工具；合并连续编辑后按此任务配置运行。',
  deleteRun: '删除记录', deleteReport: '删除报告', confirmDelete: '确认删除', deleted: '已删除',
  deleteRunHint: '永久删除这条运行记录。扫描任务、历史报告和 DSH 对话会保留。',
  deleteReportHint: '永久删除这份报告的 HTML、JSON 及内含的代码证据，无法恢复。保留运行记录和 DSH 对话；已导出的副本不受影响。正在使用的基线报告不可删除。',
  runBusy: '扫描仍在执行或收尾，请结束后再删除。', reportInUse: '报告正被任务用作基线或正在执行的扫描使用，请先修改基线配置并等待扫描结束。',
  runNotFound: '记录已不存在，请刷新列表。', reportNotFound: '报告已不存在，请刷新列表。', unsafeReportDelete: '报告目录包含未知内容、链接或无效数据，未执行删除。请检查报告目录。',
  save: '保存任务', saveRun: '保存并运行', cancel: '取消', edit: '编辑', run: '立即扫描', remove: '移除', removeTitle: '移除任务定义', removeHint: '运行记录和报告会保留；已安装的 Git hooks 不会自动移除。', confirm: '确认',
  queued: '排队中', running: '扫描中', cancelling: '正在取消', succeeded: '已完成', partial: '已结束（旧记录）', failed: '失败', cancelled: '已取消', interrupted: '已中断',
  preparing: '准备代码快照', scanning: '执行扫描', baselinePhase: '比较基线', reportPhase: '生成报告', finished: '已结束', manual: '手动', editTrigger: '编辑触发',
  taskName: '任务', createdAt: '开始时间', status: '状态', actions: '操作', findings: '候选问题', openReport: '查看报告', closeReport: '返回工作台', downloadHtml: '下载 HTML', downloadJson: '下载 JSON 留档',
  reportHint: 'JSON 是报告唯一数据源；HTML 用于查看。规则完成不等于模型已复核。', rulesHint: '每个任务可独立启用 AI 复核；执行结束后发布最终报告。也可在 DSH 会话中使用 security-review。',
  hook: 'Git hooks', hookTitle: '管理 Git 自动检查', hookHint: '只修改下面列出的仓库 hook，不覆盖已有用户脚本。保存任务不会自动安装或更新 hook。Git hooks 执行 Semgrep 静态规则，不启动模型，也不启用依赖查询或密钥检测。',
  hookEvent: '触发时机', preCommit: '提交前（暂存区）', prePush: '推送前（实际提交）', hookInstall: '安装 hook', hookRemove: '卸载本插件 hook', hookConfirm: '确认修改仓库 hook',
  enforce: '扫描失败或不完整时阻断', enforceHint: '默认仅提醒。候选风险不冒充已确认漏洞来阻断提交。', hookDone: 'Git hook 操作已完成。',
  semgrepPath: 'Semgrep 路径', gitleaksPath: 'Gitleaks 路径', reportDirectory: '报告保存目录', hookTools: '触发自动检查的 DSH 工具', hookToolsHint: '每行一个工具名，默认包含 write、edit、str_replace_editor；编辑器的 view 操作不会触发。',
  legacyAuto: '其他工作区使用全局自动检查', legacyHint: '保留旧版设置：没有匹配自动任务的工作区，编辑后对 HEAD 做增量规则检查。',
  saveSettings: '保存设置', settingsSaved: '扫描设置已保存。', scannerHint: '首次自动下载已校验的扫描器和独立 Python，随后复用，无需修改系统环境。扫描任务会等待环境就绪。',
  readOnly: '当前设置只读', invalidInput: '请检查目录、基线和扫描模式的组合。', operationFailed: '操作失败，请检查路径、Git 授权或 Host 日志。',
  taskChanged: '任务已在其他页面修改，请刷新后重新编辑。', taskBusy: '任务已有排队或运行中的扫描，请先取消或等待结束。',
  queueFull: '队列已满，请稍后重试。', taskNotFound: '任务已不存在，请刷新。', pathRequired: '请填写绝对路径。', codeDirectory: '请选择具体的代码目录。',
  serviceStopped: '服务正在停止，请重新连接。', storeLocked: '另一个实例正在使用任务目录，请退出该实例后重试。', localHookOnly: 'Git hook 只适用于本地仓库。',
  scanFailed: '扫描失败，请检查仓库、分支、扫描器或 Host 日志。', hostRestarted: 'Host 重启中断了上次扫描，可以手动重新运行。', storeFailed: '任务记录写入失败，请检查目录权限和磁盘空间。',
  hookFailed: '无法修改 hook：检查是否已有脚本或 hooksPath，以及推送基线是否有效。', tooLarge: '报告过大，请缩小扫描范围。', taskLimit: '最多保存 100 个任务。',
  reportAccess: '报告目录暂时无法读取，可在扫描设置中修改；任务记录仍保留。',
  autoLabel: '自动检查', taskSaved: '任务已保存。', source: '代码仓库', noBaseline: '未设置基线', countSuffix: '项',
  cacheHit: '缓存命中',
} as const
export type LocaleKey = keyof typeof zh
export const en: Record<LocaleKey, string> = {
  emptySubmission: 'Submit at least one review or finding; use the checkpoint to inspect progress.',
  chineseRequired: 'Evidence, recommendations and verification must be written in Chinese.',
  redactedSecret: 'The tool redacted this credential. Keep it pending until its original value is verified.',
  sourcePreview: 'Scanned source location', closeSource: 'Close source', sourceUnavailable: 'The scanned source is unavailable or has changed. Run a new scan.',
  nativeCompleted: 'Agent execution completed', nativeStopped: 'Agent stopped; see its termination reason', coveragePartial: 'Scan coverage has gaps; see the report for details.', resultConfirmed: 'Confirmed', resultPending: 'Pending', resultDismissed: 'Dismissed', agentRounds: 'rounds',
  agentPreset: 'Execution mode: Security audit (native tools + compaction)', agentPresetHint: 'Workbench scans create a security audit session. Conversation scans continue in the original session, keeping its model and configuration.', agentPresetMissing: 'Security audit preset unavailable. Check the preset directory and conflicting files.',
  scanReportNotice: 'Security scan · Report and execution outcome',
  agentOutputLimit: 'Model response reached the output token limit',
  syncSession: 'Sync to a DSH session', syncSessionHint: 'Conversation scans reuse their session; workbench AI scans create one. This option controls rule-only observation sessions and extra progress notices.', openSession: 'Open session', conversationTrigger: 'Conversation', coverageDetails: 'Coverage and diagnostics', sessionUnavailable: 'Session synchronization failed or is unavailable. Scanning continues; see run history for results.',
  invalidArguments: 'Model tool arguments were invalid. Field details were returned for correction.', unreadCitation: 'Citations include unread lines. Read those lines first.', citationRequired: 'Citations do not cover the finding location.', sourceOnly: 'File is outside source review scope. Dependency and non-source findings remain in the rules report.', readBudget: 'Evidence response is too large. Request fewer files or lines.', sourceChanged: 'Source changed after scanning. Run a new scan.', unknownFinding: 'Candidate ID is outside this source review.', planRequired: 'Select a review plan first.', planStarted: 'The plan is active. Continue collecting evidence or submitting results.', unsupportedTool: 'Tool is unavailable or finish was requested in the wrong order.',

  enginesTitle: 'Scan environment', engineReady: 'Ready', engineInstalling: 'Preparing', engineFailed: 'Setup failed', engineIdle: 'Not prepared', engineRetry: 'Prepare / retry',
  managedDefault: 'Managed by the plugin', engineOverrides: 'Advanced settings', overrideHint: 'Leave blank for managed tools, or provide absolute paths to existing tools. Custom tools must match verified versions.',
  semgrepPurpose: 'Python, Go and JS / TS rules', gitleaksPurpose: 'Detect accidentally committed secrets', viewEnvironment: 'View environment',
  engineChecking: 'Checking installed versions', engineDownload: 'Downloading and verifying runtime tools', enginePython: 'Preparing private Python', engineSemgrep: 'Installing locked Semgrep dependencies', engineGitleaks: 'Downloading and verifying Gitleaks',
  engineFailureHint: 'Check connectivity, directory permissions and free space, then retry. Custom paths are unaffected.', engineLockHint: 'Another setup owns the lock. Retry after it completes. Inspect ownership before removing a lock left by an interrupted process.', engineUnsupportedHint: 'Automatic setup is unavailable on this platform. Configure existing scanners in advanced settings.', engineIntegrityHint: 'Package integrity verification failed. The file was not executed. Check the download source before retrying.',
  sourceSection: 'Code source', policySection: 'Scan policy', taskIntro: 'Save scan scope, baseline and automatic checks for each repository.',

  rulesReport: 'Original rules report', agentAdditional: 'Additional findings', copySuffix: '(copy)',
  agentModelMissing: 'No DSH default model configured', agentStepLimit: 'Model call limit reached', agentTimeLimit: 'Time limit reached', agentContextLimit: 'Context or output budget exceeded', agentModelFailed: 'Model request failed. Check DSH model settings.', agentInvalid: 'Model did not return valid tool calls', agentEvidenceMissing: 'Some candidates lack reviewable source evidence',
  agent: 'AI evidence review', agentEnable: 'Enable Agentic AI', agentHint: 'After scanning, the DSH model selects evidence, traces risks and suggests fixes. Selected source is sent to that model. Automatic checks use this policy too.',
  agentDefault: 'Use the DSH default model', agentAdvanced: 'Model selection', agentModelsLoading: 'Loading models…', agentModelsRefresh: 'Refresh models', agentModelsHint: 'Models configured in DSH. The default option follows changes to the DSH default model.', agentModelsEmpty: 'No models listed. Configure models in DSH settings, then refresh.', agentModelsFailed: 'Some model lists could not be loaded. Refresh to retry; saved selections are retained.', agentSavedModel: 'Saved, not listed', agentSavedModelHint: 'This model is not advertised or its configuration was removed. Your selection is retained; check DSH model settings before running.',
  agentSteps: 'Maximum model calls', agentMinutes: 'Maximum minutes', agentTokens: 'Maximum output tokens per call', agentBudget: 'Exit conditions, output limits and context management come from the native DSH runtime; the plugin adds no round or time limit.',
  flow: 'Snapshot → Rules and baseline → AI evidence review → HTML report', agentDetails: 'AI activity', agentRound: 'Model calls', agentFiles: 'Files read', agentReviewed: 'Candidates reviewed',
  listing: 'Discovering files', planning: 'Planning review', reading: 'Reading snapshot evidence', reviewing: 'Saving conclusions', rejected: 'Invalid operation rejected', agentIncomplete: 'AI review incomplete', agentCompleted: 'AI flow finished (not security certification)',
  duplicate: 'Duplicate task', taskSearch: 'Search tasks or repositories', noTaskMatch: 'No matching tasks',

  entry: 'Security scan', title: 'Security workspace', subtitle: 'Manage code audits, automatic checks and reports', back: 'Back to DSH',
  tasks: 'Tasks', runs: 'Runs', settings: 'Scan settings', reports: 'Reports', newTask: 'New task', refresh: 'Refresh', loading: 'Loading…',
  emptyTasks: 'No scan tasks yet', emptyTasksHint: 'Add a local directory or repository URL, then run it whenever needed.', emptyRuns: 'No runs yet', emptyReports: 'No reports yet',
  name: 'Task name', kind: 'Source', local: 'Local directory', remote: 'Repository URL', target: 'Directory or repository URL', localHint: 'Enter an absolute code directory path', remoteHint: 'HTTPS or SSH URL; uses local Git authorization. Do not embed credentials.',
  ref: 'Branch or commit (optional)', refHint: 'Blank scans local working files or the remote default branch.', scope: 'Scope', full: 'Full', diff: 'Diff', staged: 'Staged',
  stagedHint: 'Reads the Git index against HEAD; excludes unstaged edits.', baseline: 'Baseline', none: 'No comparison', git: 'Git branch / commit', report: 'Saved report',
  base: 'Baseline branch or commit', baseHint: 'Diff scans use its merge base with the current commit.', baselineId: 'Select saved report', selectReport: 'Select a report',
  engine: 'Scan method', auto: 'Static rules', inventory: 'Inventory only (no security rules)', dependencies: 'Check dependency vulnerabilities', dependenciesHint: 'Sends package names and versions to OSV, not source code.', secrets: 'Detect exposed secrets', secretsHint: 'Gitleaks is prepared automatically. Reports redact matched secrets.',
  view: 'Initial report filter', all: 'All findings', new: 'New findings', autoScan: 'Scan after DSH edits', autoHint: 'Coalesces calls to configured edit tools and runs this saved task.',
  deleteRun: 'Delete record', deleteReport: 'Delete report', confirmDelete: 'Confirm deletion', deleted: 'Deleted',
  deleteRunHint: 'Permanently delete this run record. The task, reports and DSH conversations remain.',
  deleteReportHint: 'Permanently delete this report’s HTML, JSON and embedded evidence. This cannot be undone. Run records, DSH conversations and exported copies remain. Reports used as baselines cannot be deleted.',
  runBusy: 'The scan is still running or finishing. Try again once it ends.', reportInUse: 'This report is a configured baseline or is used by an active scan. Change the baseline and wait for the scan to finish.',
  runNotFound: 'This record no longer exists. Refresh the list.', reportNotFound: 'This report no longer exists. Refresh the list.', unsafeReportDelete: 'The report directory contains unknown content, links or invalid data. Deletion was refused. Check the report directory.',
  save: 'Save task', saveRun: 'Save and run', cancel: 'Cancel', edit: 'Edit', run: 'Run scan', remove: 'Remove', removeTitle: 'Remove task definition', removeHint: 'Run history and reports remain. Installed Git hooks are not removed.', confirm: 'Confirm',
  queued: 'Queued', running: 'Running', cancelling: 'Cancelling', succeeded: 'Completed', partial: 'Ended (legacy record)', failed: 'Failed', cancelled: 'Cancelled', interrupted: 'Interrupted',
  preparing: 'Preparing snapshot', scanning: 'Scanning', baselinePhase: 'Comparing baseline', reportPhase: 'Writing report', finished: 'Finished', manual: 'Manual', editTrigger: 'After edit',
  taskName: 'Task', createdAt: 'Started', status: 'Status', actions: 'Actions', findings: 'Candidates', openReport: 'View report', closeReport: 'Back to workspace', downloadHtml: 'Download HTML', downloadJson: 'Download JSON',
  reportHint: 'JSON is the source of truth; HTML is the view. Rule completion does not imply model review.', rulesHint: 'Enable AI review per task. Original and reviewed reports are retained. You can also use security-review in a DSH conversation.',
  hook: 'Git hooks', hookTitle: 'Manage Git checks', hookHint: 'Only the selected repository hook is changed. Existing scripts are preserved. Saving a task does not install or update hooks. Git hooks run Semgrep rules only, without model review, dependency queries or secret scanning.',
  hookEvent: 'Trigger', preCommit: 'Before commit (index)', prePush: 'Before push (pushed commits)', hookInstall: 'Install hook', hookRemove: 'Remove plugin hook', hookConfirm: 'Confirm repository hook change',
  enforce: 'Block on scan failure or incomplete coverage', enforceHint: 'Advisory by default. Candidates are not treated as confirmed vulnerabilities.', hookDone: 'Git hook operation completed.',
  semgrepPath: 'Semgrep path', gitleaksPath: 'Gitleaks path', reportDirectory: 'Report directory', hookTools: 'DSH edit tools that trigger scans', hookToolsHint: 'One per line. Defaults include write, edit and str_replace_editor; editor view operations do not trigger scans.',
  legacyAuto: 'Use global auto checks for other workspaces', legacyHint: 'Preserves the previous setting: workspaces without an automatic task are checked against HEAD after edits.',
  saveSettings: 'Save settings', settingsSaved: 'Scan settings saved.', scannerHint: 'Verified scanners and private Python are prepared once and reused without changing the system environment. Scans wait for setup.',
  readOnly: 'Settings are read-only', invalidInput: 'Check the directory, baseline and scan mode.', operationFailed: 'Operation failed. Check paths, Git access or the Host log.',
  taskChanged: 'This task changed in another window. Refresh before editing.', taskBusy: 'This task already has an active run. Cancel it or wait.', queueFull: 'Queue is full. Try again later.', taskNotFound: 'Task no longer exists. Refresh the page.', pathRequired: 'An absolute path is required.', codeDirectory: 'Select a specific code directory.',
  serviceStopped: 'Service is stopping. Reconnect to continue.', storeLocked: 'Another instance owns the task directory. Close it first.', localHookOnly: 'Git hooks require a local repository.',
  scanFailed: 'Scan failed. Check the repository, branch, scanner or Host log.', hostRestarted: 'Host restart interrupted the run. Run it again when ready.', storeFailed: 'Unable to persist tasks. Check directory access and disk space.', hookFailed: 'Unable to change hook. Check existing scripts, hooksPath and push baseline.', tooLarge: 'Report is too large. Reduce scan scope.', taskLimit: 'At most 100 saved tasks.',
  reportAccess: 'Report directory is unavailable. Update it in Scan settings; task records are retained.',
  autoLabel: 'Automatic', taskSaved: 'Task saved.', source: 'Repository', noBaseline: 'No baseline', countSuffix: 'items',
  cacheHit: 'cache hit',
}
export function errorKey(code: string): LocaleKey {
  const keys: Record<string, LocaleKey> = { 'empty-submission': 'emptySubmission', 'chinese-required': 'chineseRequired', 'redacted-secret': 'redactedSecret', 'scan-session-unavailable': 'sessionUnavailable', 'invalid-arguments': 'invalidArguments', 'unread-citation': 'unreadCitation', 'citation-required': 'citationRequired', 'source-only': 'sourceOnly', 'read-budget': 'readBudget', 'source-changed': 'sourceChanged', 'unknown-finding': 'unknownFinding', 'plan-required': 'planRequired', 'plan-already-started': 'planStarted', 'unsupported-tool': 'unsupportedTool', 'tool-rejected': 'unsupportedTool', 'evidence-unavailable': 'agentEvidenceMissing', 'file-budget': 'agentContextLimit', 'finding-budget': 'agentContextLimit', 'evidence-required': 'agentEvidenceMissing', 'report-directory-unavailable': 'reportAccess', 'invalid-input': 'invalidInput', 'task-changed': 'taskChanged', 'task-busy': 'taskBusy', 'queue-full': 'queueFull', 'task-not-found': 'taskNotFound', 'absolute-path-required': 'pathRequired', 'code-directory-required': 'codeDirectory', 'service-stopped': 'serviceStopped', 'task-store-locked': 'storeLocked', 'local-hook-only': 'localHookOnly', 'settings-read-only': 'readOnly', 'scan-failed': 'scanFailed', 'host-restarted': 'hostRestarted', 'store-write-failed': 'storeFailed', 'task-store-full': 'storeFailed', 'hook-failed': 'hookFailed', 'source-unavailable': 'sourceUnavailable', 'invalid-source-location': 'sourceUnavailable',
  'report-too-large': 'tooLarge', 'task-limit': 'taskLimit', cancelled: 'cancelled' }
  Object.assign(keys, { 'run-busy': 'runBusy', 'report-in-use': 'reportInUse', 'run-not-found': 'runNotFound', 'report-not-found': 'reportNotFound', 'unsafe-report-delete': 'unsafeReportDelete' })
  return keys[code] ?? 'operationFailed'
}

export function agentReasonKey(reason: string): LocaleKey {
  const keys: Record<string, LocaleKey> = { 'empty-submission': 'emptySubmission', 'chinese-required': 'chineseRequired', 'redacted-secret': 'redactedSecret', completed: 'agentCompleted', 'step-limit': 'agentStepLimit', 'time-limit': 'agentTimeLimit', 'context-limit': 'agentContextLimit', 'output-limit': 'agentOutputLimit', 'preset-unavailable': 'agentPresetMissing', 'model-unavailable': 'agentModelMissing', 'model-failed': 'agentModelFailed', 'invalid-response': 'agentInvalid', 'evidence-unavailable': 'agentEvidenceMissing', cancelled: 'cancelled' }
  return keys[reason] ?? 'agentIncomplete'
}

export function enginePhaseKey(phase: string): LocaleKey {
  const keys: Record<string, LocaleKey> = { 'empty-submission': 'emptySubmission', 'chinese-required': 'chineseRequired', 'redacted-secret': 'redactedSecret', idle: 'engineIdle', checking: 'engineChecking', download: 'engineDownload', python: 'enginePython', semgrep: 'engineSemgrep', gitleaks: 'engineGitleaks', ready: 'engineReady' }
  return keys[phase] ?? 'engineInstalling'
}
export function engineErrorKey(code: string): LocaleKey {
  return code === 'toolchain-locked' ? 'engineLockHint' : code === 'toolchain-unsupported' ? 'engineUnsupportedHint' : code === 'toolchain-integrity' ? 'engineIntegrityHint' : 'engineFailureHint'
}
