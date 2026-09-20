import type { Finding, Report } from './report.js'
import { groupFindings } from './report-groups.js'
const escape = (value: string): string => value.replace(/[&<>"']/gu, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!)
const unique = (values: string[]): string[] => [...new Set(values)]
export const riskNames: Record<string, string> = { 'CWE-295': '未校验 HTTPS 服务器证书', 'CWE-502': '反序列化数据的来源需要核实', 'CWE-79': 'HTML 输出与脚本注入风险', 'CWE-78': '外部输入进入 Shell 命令', 'CWE-95': '动态执行代码', 'CWE-89': 'SQL 拼接与注入风险', 'CWE-798': '疑似凭据，需要核实是否真实' }
export function needsSecretRecheck(item: Finding): boolean {
  return item.engine === 'gitleaks' && item.status === 'dismissed' && /\[REDACTED(?: PRIVATE KEY)?\]/iu.test(item.evidence + item.verification)
}
export function reportSummary(report: Report) {
  const source = report.findings.filter(item => !['osv', 'gitleaks'].includes(item.engine))
  return { sourceConfirmed: source.filter(item => item.status === 'confirmed'), sourcePending: source.filter(item => item.status === 'needs-review'), secrets: report.findings.filter(item => item.engine === 'gitleaks' && item.status !== 'dismissed'), packages: groupFindings(report.findings.filter(item => item.engine === 'osv' && item.status !== 'dismissed')), recheck: report.findings.filter(needsSecretRecheck), dismissed: report.findings.filter(item => item.status === 'dismissed').length }
}
const guidance = (cwe: string): string => {
  if (cwe === 'CWE-295') return '统一恢复证书和主机名校验；内部证书接入受信任 CA。验证错误证书被拒绝、正常组件请求仍成功。是否可被中间人利用，还取决于实际网络与部署条件。'
  if (cwe === 'CWE-502') return '先核实谁能写入待反序列化数据，以及这些数据能否到达加载函数。若来源不可信，改用受限数据格式与固定类型白名单；不要仅换成可任意指定类名的动态加载。'
  if (cwe === 'CWE-79') return '追踪内容来源和净化步骤，确认最终插入页面前进行了适合该上下文的转义或净化。'
  return '打开源码与原始复核依据，确认外部输入、调用链和现有保护；修复后补充对应的回归测试。'
}
export function renderSummary(report: Report, location: (file: string, line: number) => string): string {
  const summary = reportSummary(report)
  const sourceCards = (items: Finding[], confirmed: boolean): string => groupFindings(items).map(group => {
    const rows = group.issues.flat()
    return '<div class="action-card"><h3>' + escape(riskNames[group.title] ?? group.title) + '</h3><p>' + (confirmed ? '复核标记为风险' : '尚未确认漏洞') + ' · ' + rows.length + ' 处 · ' + unique(rows.map(row => row.file)).length + ' 个文件</p><div class="locations">' + rows.map(row => '<p>' + location(row.file, row.line) + '</p>').join('') + '</div><p><b>下一步：</b>' + guidance(group.title) + '</p><button class="inspect" data-type="源码风险" data-status="' + (confirmed ? 'confirmed' : 'needs-review') + '" data-query="' + escape(group.title) + '">查看证据与原始结论</button></div>'
  }).join('') || '<p class="muted">本次没有这类记录。</p>'
  const packages = summary.packages.sort((a, b) => b.issues.length - a.issues.length || a.title.localeCompare(b.title))
  const depRows = packages.map(group => {
    const rows = group.issues.flat(), fixed = unique(rows.flatMap(row => row.dependency?.fixedVersions ?? []))
    return '<tr><td><b>' + escape(group.title) + '</b><p>' + escape(unique(rows.flatMap(row => row.dependency ? [row.dependency.version] : [])).join(' / ')) + '</p></td><td>' + group.issues.length + ' 个公告关联的问题<small> · ' + rows.length + ' 条原始记录</small></td><td>' + unique(rows.map(row => row.file)).map(file => location(file, rows.find(row => row.file === file)!.line)).join('<br>') + '</td><td>' + (fixed.length ? '<details><summary>查看公告修复版本（' + fixed.length + '）</summary><p>' + escape(fixed.join(' / ')) + '</p><small>核对维护分支与兼容性；这些是公告记录，不是已验证的统一升级目标。</small></details>' : '暂无修复版本信息，需查上游公告') + '<button class="inspect" data-type="依赖漏洞" data-status="" data-query="' + escape(group.title) + '">查看该包详情</button></td></tr>'
  }).join('')
  return '<section class="stats"><div class="stat">复核标记的源码风险<b>' + summary.sourceConfirmed.length + '<small> 处</small></b></div><div class="stat">需继续追踪的源码<b>' + summary.sourcePending.length + '<small> 处</small></b></div><div class="stat">待核实凭据<b>' + summary.secrets.length + '<small> 条</small></b></div><div class="stat">需评估升级的依赖<b>' + packages.length + '<small> 个包</small></b></div></section><section class="panel verdict"><h2>先看这几件事</h2><p>下面是处理清单，不把所有数据库记录当成已证实漏洞。源码结论来自规则与复核，是否实际可利用仍需结合调用链和部署条件验证。</p><div class="actions"><button class="jump" data-target="source-actions">源码怎么处理</button><button class="jump" data-target="secret-actions">凭据怎么核实</button><button class="jump" data-target="dependency-actions">依赖怎么升级</button><button class="jump" data-target="coverage-summary">哪些没有检查完</button></div></section><section class="panel" id="source-actions"><h2>1. 处理源码风险</h2>' + sourceCards(summary.sourceConfirmed, true) + '<h3 class="subheading">还需要核实的调用链</h3>' + sourceCards(summary.sourcePending, false) + '</section><section class="panel" id="secret-actions"><h2>2. 核实疑似凭据</h2><p>' + summary.secrets.length + ' 条记录尚待确认。先判断是否真实有效、是否进入版本历史；真实凭据应轮换，仅删除文件不够。测试目录中的内容也不能自动视为无风险。</p>' + summary.secrets.map(item => '<p>' + location(item.file, item.line) + '</p>').join('') + (summary.recheck.length ? '<div class="quality-warning"><b>另有 ' + summary.recheck.length + ' 条历史“已排除”结论需要复查</b><p>这些结论引用了脱敏占位符。占位符可能是扫描工具隐藏了真实值，不能作为“原文件没有密钥”的依据。这里保留原始状态，不自动认定安全。</p>' + summary.recheck.map(item => '<p>' + location(item.file, item.line) + '</p>').join('') + '</div>' : '') + '<button class="inspect" data-type="凭据泄漏" data-status="" data-query="">查看凭据记录</button></section><section class="panel" id="dependency-actions"><h2>3. 按依赖包安排升级</h2><p>共 ' + report.findings.filter(item => item.engine === 'osv').length + ' 条数据库记录，当前待处理项涉及 ' + packages.length + ' 个包。一次升级可能解决同包的多个公告；这些记录尚未证明应用中能够触发相应漏洞。</p><p class="muted">先确认部署实际使用的版本，集中修改依赖约束与锁文件，运行测试后复扫。不会仅取最大的修复版本就宣称问题全部解决。</p>' + (packages.length ? '<div class="dependency-table"><table><thead><tr><th>依赖 / 当前版本</th><th>公告合并后的数量</th><th>声明位置</th><th>下一步</th></tr></thead><tbody>' + depRows + '</tbody></table></div>' : '<p>本次没有待处理的依赖记录。是否启用依赖扫描见下方覆盖说明。</p>') + '</section>'
}
