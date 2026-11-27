# Security Scan 0.17.0 验证

日期：2026-11-06。环境：macOS arm64；官方 DSH 0.2.1-rc.5；Semgrep CE 1.176.1。此记录不表示已更新任何现有用户安装；已安装用户执行 `dhp update` 换到该发布包。

## 变更

- 误报排除：在报告“接下来，处理扫描结果”中选中问题并填写原因后标记为误报。之后的扫描在同一仓库、引擎、规则、文件且代码指纹一致时自动标为已排除并默认隐藏，不计入失败阈值、CLI 退出码和 SARIF，也不进入 AI 复核；代码改动、文件改名或其他仓库会重新显示。记录保存在本机 `security-scan/suppressions.json`，不写入被扫描仓库，最多 5000 条；「扫描设置 → 已排除的问题」可搜索与恢复。CLI 新增 `suppress --action list|add|remove`，`scan` 新增 `--suppressions` 与 `--ignore-suppressions`，Git hook 默认使用同一份列表。AI 补充的发现不能排除。文件为符号链接、格式错误或被占用时扫描照常完成并在报告中说明。
- 规则从 12 条扩充到 29 条，覆盖 Flask、Django、Jinja2、Express、Koa、Next.js 路由、React、net/http、gorilla/mux、Gin、Echo、database/sql、GORM 与 html/template。新增 SQL 拼接（Python / JS / TS，Go 扩充到 QueryRow 和字符串拼接）、模板源码拼接、`mark_safe` / `Markup`、Flask `debug=True`、JWT 不验签、`vm`、`dangerouslySetInnerHTML` 等 HTML sink、带凭据的任意来源 CORS、`template.HTML`；SSRF、路径穿越和开放跳转使用函数内污点追踪，固定域名前缀、常量表、`basename` / `secure_filename` / `filepath.IsLocal` 等防护视为已处理。shell、eval、HTML 和 SQL sink 的纯字符串字面量不再报告。规则源码移到 `scripts/build-rules.mjs`，测试检查生成的 `rules/baseline.yml` 与之一致。
- 修复提示与报告标题补充路径穿越、SSRF、开放跳转、模板注入、调试模式、JWT 与 CORS 的中文要点。
- 评测语料从 42 例扩充到 97 例（46 个风险样例、51 个安全样例），每条规则至少有一个必须检出的样例；评测支持 `.jsx` / `.tsx`。

## 评测结果

三次真实运行结果一致：TP 41、FN 5、FP 2、TN 49；精确率 95.3%、召回率 89.1%、F1 92.1%；端到端耗时 1762 / 1629 / 1596 ms。漏报为三种语言的缺失授权、Django 越权和跨函数 SSRF；误报为模块常量中的 HTML 与按解析后主机名白名单防护的 SSRF。原 42 例在新规则下从 TP 16 / FN 4 / FP 6 / TN 16 变为 TP 19 / FN 1 / FP 0 / TN 22。规则与语料同时变化，因此逐例审查后替换了基线；新样例与新规则由同一作者同时编写，结果偏乐观，不是独立测量。

## 通过的检查

- 插件：TypeScript 严格检查、Host/Client 发布构建通过；测试 20 个文件、183 项通过、1 项可选安装目录测试跳过，已启用真实 Semgrep。新增覆盖：扫描时按指纹排除且行号移动仍匹配、SARIF 与退出码、已排除项拒绝复核、恢复、其他仓库与改动代码重新出现、无效输入、符号链接与格式错误的存储、并发写入、CLI；任务服务通过 RPC 排除后当前报告立即更新，下次扫描自动标为已排除，恢复后重新出现；规则文件与生成源码一致；真实语料逐例漏报 / 误报清单及每条规则均有检出样例。
- 隔离 Playwright UI 脚本通过：未填写原因时不能确认排除，排除后从可处理列表移除并显示已排除数量，扫描设置中可看到原因并恢复，窄屏无横向溢出。
- 根目录 export-public、catalog 兼容与独立导出测试通过。发布包测试解包真实 tarball，在隔离 `DSH_HOME` 中完成评测基线门禁、uv.lock 扫描、运行时检查，以及通过 CLI 排除问题、下次扫描标为已排除、恢复后重新出现。
- 开发 Node 26.7.0 下官方 Web 入口启动检查：注册 20 个工具和 2 个 Skills，授权页面与安全扫描 RPC 正常。

## 发布

- 组件版本：`0.17.0`；报告版本：`0.17.0`；DSH 声明：仅 `0.2.1-rc.5`。
- 文件：`artifacts/shamcleren-dsh-security-scan-0.17.0.tgz`，206 个文件，不含内部主机名、AIDEV 或本机路径。
- 大小：`333477` 字节。
- SHA-256：`8d2c430ef01d56ccca961eedaf97bc19023b1514010f13f820e9d785537b444e`。
- 未发布到 npm。

## 验证边界

只验证了 DSH 0.2.1-rc.5。真实扫描只在 macOS arm64 上验证；Windows 与官方 Electron 桌面 UI 未验证。评测语料是小型合成集，不代表真实项目检出率。规则不跨函数或文件追踪，也不解析常量变量的值。未接入第三方 DAST；运行时检查仍是最多 12 个同源 GET 请求的只读基线。修复闭环未调用真实模型完成端到端修复。未修改任何用户 profile。
