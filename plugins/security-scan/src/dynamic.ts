import { randomUUID } from 'node:crypto'
import { hash } from './repository.js'
import { PLUGIN_VERSION, type Finding, type Report } from './report.js'
import { dynamicTarget } from './ui-contract.js'

type Engine = Report['engines'][number]
export const DYNAMIC_VERSION = 'baseline-v1'
const BODY_LIMIT = 256 * 1024, MAX_REQUESTS = 12, PROBE_ORIGIN = 'https://dsh-security-probe.invalid'
interface Response { url: URL; status: number; headers: Headers; body: string }
interface Rule { rule: string; cwe: string; severity: Finding['severity']; title: string; recommendation: string }
const rules = {
  csp: { rule: 'dynamic.header-csp', cwe: 'CWE-693', severity: 'low', title: '页面未设置 Content-Security-Policy', recommendation: '为 HTML 响应设置限制脚本来源的 CSP（至少 default-src \'self\'，避免 unsafe-inline），先用 Report-Only 观察再启用。Express 可用 helmet，Django 可用 django-csp 或在反向代理统一添加。' },
  nosniff: { rule: 'dynamic.header-nosniff', cwe: 'CWE-693', severity: 'low', title: '响应未设置 X-Content-Type-Options: nosniff', recommendation: '在应用或反向代理为所有响应添加 X-Content-Type-Options: nosniff。Django 设置 SECURE_CONTENT_TYPE_NOSNIFF = True；Express 可用 helmet；Go 在中间件中设置该响应头。' },
  frame: { rule: 'dynamic.header-clickjacking', cwe: 'CWE-1021', severity: 'medium', title: '页面可被任意站点嵌入（点击劫持）', recommendation: '设置 CSP frame-ancestors \'self\'（或需要的可信来源），并保留 X-Frame-Options: DENY/SAMEORIGIN 兼容旧浏览器。Django 使用 XFrameOptionsMiddleware；Express 可用 helmet.frameguard。' },
  hsts: { rule: 'dynamic.header-hsts', cwe: 'CWE-319', severity: 'medium', title: 'HTTPS 响应未设置 Strict-Transport-Security', recommendation: '确认全站支持 HTTPS 后设置 Strict-Transport-Security: max-age=31536000; includeSubDomains，先用较短 max-age 验证。可在应用或负载均衡统一配置。' },
  cleartext: { rule: 'dynamic.cleartext', cwe: 'CWE-319', severity: 'medium', title: '非本机服务通过明文 HTTP 提供', recommendation: '为该服务启用 HTTPS 并把 HTTP 永久重定向到 HTTPS；内部服务也应评估传输链路是否可被监听。' },
  httponly: { rule: 'dynamic.cookie-httponly', cwe: 'CWE-1004', severity: 'low', title: 'Cookie 未设置 HttpOnly', recommendation: '会话和认证 Cookie 设置 HttpOnly，防止脚本读取；前端确需读取的 Cookie 不应承载凭据。Django 检查 SESSION_COOKIE_HTTPONLY；Express 在 cookie 选项中设置 httpOnly: true。' },
  secure: { rule: 'dynamic.cookie-secure', cwe: 'CWE-614', severity: 'medium', title: 'HTTPS 下 Cookie 未设置 Secure', recommendation: '在 HTTPS 服务中为 Cookie 设置 Secure。Django 设置 SESSION_COOKIE_SECURE / CSRF_COOKIE_SECURE = True；Express 设置 secure: true 并正确配置 trust proxy。' },
  samesite: { rule: 'dynamic.cookie-samesite', cwe: 'CWE-1275', severity: 'low', title: 'Cookie 未声明 SameSite', recommendation: '为 Cookie 明确设置 SameSite=Lax 或 Strict；跨站场景需要 None 时必须同时设置 Secure，并保留 CSRF 防护。' },
  version: { rule: 'dynamic.version-disclosure', cwe: 'CWE-200', severity: 'info', title: '响应头暴露服务端组件版本', recommendation: '移除或泛化 Server / X-Powered-By 中的版本号（Express: app.disable(\'x-powered-by\')；nginx: server_tokens off）。版本信息本身不是漏洞，但会帮助攻击者匹配已知缺陷。' },
  listing: { rule: 'dynamic.directory-listing', cwe: 'CWE-548', severity: 'medium', title: '目录列表可公开浏览', recommendation: '关闭静态服务器的目录索引，只发布构建产物目录；确认没有源码、备份或配置文件被一并暴露。' },
  cors: { rule: 'dynamic.cors-reflect', cwe: 'CWE-942', severity: 'medium', title: 'CORS 反射任意来源', recommendation: '把 Access-Control-Allow-Origin 限制为明确允许的来源列表，不要回显请求的 Origin；需要携带凭据时尤其如此。补充来自未授权来源的拒绝测试。' },
  corsCredentials: { rule: 'dynamic.cors-credentials', cwe: 'CWE-942', severity: 'high', title: 'CORS 允许任意来源携带凭据', recommendation: '立即改为来源白名单；仅为可信来源返回 Access-Control-Allow-Credentials: true。验证未授权来源的带凭据请求不会获得响应。' },
  debug: { rule: 'dynamic.debug-error', cwe: 'CWE-209', severity: 'medium', title: '错误页面暴露调试信息或堆栈', recommendation: '在生产配置中关闭调试模式（Django DEBUG=False、Flask debug=False、Express NODE_ENV=production），并用统一错误页返回通用信息；堆栈只写入服务端日志。' },
  git: { rule: 'dynamic.git-exposed', cwe: 'CWE-538', severity: 'high', title: '可通过 HTTP 读取 .git 仓库元数据', recommendation: '禁止 Web 服务器访问 .git 目录并从发布目录中移除它；按已泄漏源码处理，检查历史中是否存在凭据并轮换。' },
  env: { rule: 'dynamic.env-exposed', cwe: 'CWE-538', severity: 'critical', title: '.env 环境配置文件可公开下载', recommendation: '立即阻止访问并从发布目录移除 .env；视其中凭据已泄漏，逐项撤销或轮换。部署时只注入运行所需的环境变量。' },
  pprof: { rule: 'dynamic.go-pprof', cwe: 'CWE-215', severity: 'medium', title: 'Go pprof 调试接口可公开访问', recommendation: '仅在内部管理端口或认证后注册 net/http/pprof，生产对外服务不要导入 _ "net/http/pprof" 到默认 mux。' },
  werkzeug: { rule: 'dynamic.werkzeug-console', cwe: 'CWE-94', severity: 'critical', title: 'Werkzeug 调试控制台可访问', recommendation: '生产环境禁止开启 Flask/Werkzeug debug；调试控制台可执行任意 Python 代码。改用正式 WSGI 服务器并关闭 debug。' },
} satisfies Record<string, Rule>
const loopback = (host: string): boolean => host === 'localhost' || host.endsWith('.localhost') || /^127\./u.test(host) || host === '[::1]'
const summarize = (url: URL): string => url.origin + url.pathname

/** Read-only runtime baseline: fixed same-origin GET requests, bounded bodies, no payloads or credentials. */
export async function scanDynamic(target: string, signal: AbortSignal, fetcher: typeof fetch = fetch): Promise<{ engine: Engine; findings: Finding[]; target: string }> {
  const base = dynamicTarget(target), findings: Finding[] = [], notes: string[] = []
  let requests = 0, incomplete = false
  const request = async (url: URL, headers: Record<string, string> = {}): Promise<Response> => {
    signal.throwIfAborted()
    if (++requests > MAX_REQUESTS || url.origin !== base.origin) throw new Error('dynamic-scope')
    const response = await fetcher(url, { method: 'GET', redirect: 'manual',
      headers: { accept: 'text/html,application/json;q=0.9,*/*;q=0.5', 'user-agent': 'dsh-security-scan/' + PLUGIN_VERSION + ' (read-only baseline)', ...headers },
      signal: AbortSignal.any([signal, AbortSignal.timeout(10_000)]) })
    let body = '', size = 0
    const reader = response.body?.getReader(), decoder = new TextDecoder()
    try {
      while (reader && size < BODY_LIMIT) { const chunk = await reader.read(); if (chunk.done) break; size += chunk.value.length; body += decoder.decode(chunk.value, { stream: true }) }
    } finally { await reader?.cancel().catch(() => {}) }
    return { url, status: response.status, headers: response.headers, body: body.slice(0, BODY_LIMIT) }
  }
  const add = (spec: Rule, response: Response, evidence: string, key = ''): void => {
    const location = summarize(response.url), fingerprint = hash('http:' + spec.rule + ':' + location + ':' + key)
    if (findings.some(item => item.fingerprint === fingerprint)) return
    const file = ('http/' + response.url.host + response.url.pathname).replace(/\/+$/u, '').replace(/[\x00-\x1f]/gu, '').slice(0, 1900)
    findings.push({ id: hash('http:' + spec.rule + ':' + location + ':' + key).slice(0, 24), fingerprint, engine: 'http', rule: spec.rule, file, line: 1, title: spec.title, cwe: spec.cwe, severity: spec.severity,
      status: 'needs-review', change: 'unknown', evidence, recommendation: spec.recommendation, endpoint: { url: location.slice(0, 2000), method: 'GET', status: response.status },
      verification: '运行时只读检查：对该地址发送 GET 请求并分析响应，未发送攻击载荷、未登录。网关、CDN 或其他环境可能另有配置，需要在实际部署中核实。' })
  }
  let page: Response | undefined
  try {
    let current = base
    for (let hop = 0; hop <= 3; hop++) {
      const response = await request(current)
      const location = response.status >= 300 && response.status < 400 ? response.headers.get('location') : null
      if (!location) { page = response; break }
      const next = new URL(location, current)
      if (next.origin !== base.origin) { notes.push('入口跳转到其他源（' + next.origin + '），未跟随；只检查了跳转响应。'); incomplete = true; inspectHeaders(response); break }
      if (hop === 3) { notes.push('同源跳转超过 3 次，停止跟随。'); incomplete = true; inspectHeaders(response); break }
      current = next
    }
  } catch {
    signal.throwIfAborted()
    return { target: summarize(base), findings: [], engine: { name: 'http', version: DYNAMIC_VERSION, status: 'failed', detail: '无法连接 ' + summarize(base) + '，未执行运行时检查。请确认服务已启动且地址可从本机访问。' } }
  }
  function inspectHeaders(response: Response): void {
    for (const header of ['server', 'x-powered-by']) {
      const value = response.headers.get(header)
      if (value && /\d+\.\d+/u.test(value)) add(rules.version, response, header + ': ' + value.slice(0, 100), header)
    }
    for (const cookie of response.headers.getSetCookie()) {
      const name = (cookie.split('=')[0] ?? '').trim().replace(/[^\w.-]/gu, '').slice(0, 80) || 'cookie'
      const attributes = cookie.split(';').slice(1).map(part => part.trim().toLowerCase())
      const has = (attribute: string): boolean => attributes.some(part => part === attribute || part.startsWith(attribute + '='))
      if (!has('httponly')) add(rules.httponly, response, 'Cookie ' + name + ' 缺少 HttpOnly（未记录 Cookie 值）。', name)
      if (response.url.protocol === 'https:' && !has('secure')) add(rules.secure, response, 'Cookie ' + name + ' 缺少 Secure（未记录 Cookie 值）。', name)
      if (!has('samesite')) add(rules.samesite, response, 'Cookie ' + name + ' 未声明 SameSite（未记录 Cookie 值）。', name)
    }
  }
  if (page) {
    inspectHeaders(page)
    const type = page.headers.get('content-type') ?? '', csp = page.headers.get('content-security-policy') ?? ''
    if (page.status < 400) {
      if (!/nosniff/iu.test(page.headers.get('x-content-type-options') ?? '')) add(rules.nosniff, page, '响应状态 ' + page.status + '，未返回 X-Content-Type-Options: nosniff。')
      if (/text\/html/iu.test(type)) {
        if (!csp) add(rules.csp, page, 'HTML 响应未返回 Content-Security-Policy。')
        if (!page.headers.get('x-frame-options') && !/frame-ancestors/iu.test(csp)) add(rules.frame, page, 'HTML 响应既没有 X-Frame-Options，CSP 也未声明 frame-ancestors。')
      }
      if (/<title>\s*(?:Index of \/|Directory listing for \/)/iu.test(page.body)) add(rules.listing, page, '页面内容符合目录索引格式。')
    }
    if (page.url.protocol === 'https:' && !page.headers.get('strict-transport-security')) add(rules.hsts, page, 'HTTPS 响应未返回 Strict-Transport-Security。')
    if (page.url.protocol === 'http:' && !loopback(page.url.hostname)) add(rules.cleartext, page, '服务地址使用 http:// 且不是本机回环地址。')
    else if (page.url.protocol === 'http:') notes.push('本机 http 地址：传输安全（HTTPS / HSTS / Secure Cookie）需在实际部署环境检查。')
  }
  const probes: Array<[string, Rule, (response: Response) => boolean]> = [
    ['.git/HEAD', rules.git, response => /^(?:ref: refs\/[\w./-]+|[a-f0-9]{40})\s*$/u.test(response.body)],
    ['.env', rules.env, response => !/text\/html/iu.test(response.headers.get('content-type') ?? '') && response.body.split('\n').filter(line => line.trim() && !line.trim().startsWith('#')).some(line => /^\s*(?:export\s+)?[A-Za-z_][A-Za-z0-9_]*\s*=/u.test(line)) && !/<[a-z!]/iu.test(response.body)],
    ['debug/pprof/', rules.pprof, response => /Types of profiles available/u.test(response.body)],
    ['console', rules.werkzeug, response => /Werkzeug/u.test(response.body) && /Interactive Console|debugger/iu.test(response.body)],
  ]
  try {
    const missing = await request(new URL('/dsh-security-probe-' + randomUUID(), base))
    if (/Traceback \(most recent call last\)|You're seeing this error because you have <code>DEBUG = True|goroutine \d+ \[running\]|\n\s+at [^\n]+\((?:\/|[A-Za-z]:\\)[^\n]+:\d+:\d+\)/u.test(missing.body)) add(rules.debug, missing, '请求不存在的路径时，响应包含 Python / Django / Node / Go 调试堆栈特征（未保存响应正文）。')
    const control = hash(missing.body)
    for (const [path, spec, matches] of probes) {
      const response = await request(new URL('/' + path, base))
      if (response.status === 200 && hash(response.body) !== control && matches(response)) add(spec, response, '响应状态 200，内容符合 ' + path + ' 的特征格式；为避免扩散，报告不保存响应正文。')
    }
    const cors = await request(base, { origin: PROBE_ORIGIN })
    const allow = cors.headers.get('access-control-allow-origin'), credentials = /^true$/iu.test(cors.headers.get('access-control-allow-credentials') ?? '')
    if (allow === PROBE_ORIGIN) add(credentials ? rules.corsCredentials : rules.cors, cors, '使用测试 Origin ' + PROBE_ORIGIN + ' 请求时，响应回显该来源' + (credentials ? '并允许携带凭据。' : '。'))
    else if (allow === '*' && credentials) add(rules.corsCredentials, cors, '响应同时返回 Access-Control-Allow-Origin: * 与 Access-Control-Allow-Credentials: true。')
  } catch {
    signal.throwIfAborted()
    incomplete = true; notes.push('部分探测请求失败或超时，相关项目未完成检查。')
  }
  const detail = '只读运行时基线检查 ' + summarize(base) + '：' + requests + ' 个同源 GET 请求，覆盖安全响应头、Cookie 属性、CORS、调试错误页、目录索引与常见敏感文件。不发送攻击载荷、不登录、不跟随跨源跳转；不是完整 DAST，不覆盖认证后页面、业务逻辑或注入测试。' + (notes.length ? ' ' + notes.join(' ') : '')
  return { target: summarize(base), findings, engine: { name: 'http', version: DYNAMIC_VERSION, status: incomplete ? 'partial' : 'completed', detail } }
}

/** Runtime findings compare only with a saved report that checked the same URL completely. */
export function mergeDynamic(report: Report, dynamic: Awaited<ReturnType<typeof scanDynamic>>, baseline?: Report): Report {
  const comparable = !!baseline && baseline.policy.dynamic === dynamic.target && dynamic.engine.status === 'completed' && baseline.engines.some(engine => engine.name === 'http' && engine.status === 'completed')
  const earlier = baseline?.findings.filter(item => item.engine === 'http') ?? []
  const previous = new Set(earlier.map(item => item.fingerprint)), current = new Set(dynamic.findings.map(item => item.fingerprint))
  const findings = dynamic.findings.map(item => ({ ...item, change: comparable ? previous.has(item.fingerprint) ? 'existing' as const : 'new' as const : 'unknown' as const }))
  const notObserved = comparable ? earlier.filter(item => !current.has(item.fingerprint)).map(item => ({ ...item, change: 'not-observed' as const })) : []
  return { ...report, engines: [...report.engines, dynamic.engine], findings: [...report.findings, ...findings].slice(0, 2000),
    ...(report.baseline ? { baseline: { ...report.baseline, notObserved: [...report.baseline.notObserved, ...notObserved].slice(0, 2000) } } : {}),
    coverage: { ...report.coverage, omittedFindings: report.coverage.omittedFindings + Math.max(0, report.findings.length + findings.length - 2000) } }
}
