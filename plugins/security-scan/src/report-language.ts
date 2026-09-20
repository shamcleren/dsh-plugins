import type { Finding } from './report.js'
export const hasChinese = (value: string): boolean => /\p{Script=Han}/u.test(value)
export function chineseFinding(item: Finding): { title: string; evidence: string; recommendation: string; verification: string } {
  if (item.engine === 'gitleaks') return { title: '疑似凭据命中', evidence: '凭据规则命中此位置。为避免泄漏，不展示匹配值或可能包含原值的自由文本。当前状态为复核记录，真实性与有效性仍需在授权环境核实。', recommendation: '若确认是真实凭据，应撤销或轮换，并移除代码中的硬编码。测试目录、脱敏占位符都不能单独证明无风险。', verification: '未尝试使用凭据，也未验证其有效性。原始值不会随 HTML 导出。' }
  if (item.engine === 'osv') return { title: '依赖版本关联到漏洞公告 · ' + item.rule, evidence: item.dependency ? '依赖 ' + item.dependency.name + ' 的 ' + item.dependency.version + ' 版本由 OSV 关联到该公告；这证明数据库关联，不证明应用中已能触发漏洞。' : '依赖数据库关联到漏洞公告；需要核实实际使用版本及受影响功能。', recommendation: hasChinese(item.recommendation) ? item.recommendation : '核对公告的受影响范围与修复版本，更新依赖约束和锁文件后测试并复扫。', verification: '依据为依赖版本与公告查询；尚未验证应用调用可达性或动态触发。' }
  return { title: hasChinese(item.title) ? item.title : '源码规则或复核发现 · ' + item.cwe, evidence: hasChinese(item.evidence) ? item.evidence : '历史记录的详细复核依据尚无中文版本；不能仅凭标题认定漏洞。可结合下方扫描位置、代码与原始引用核查。', recommendation: hasChinese(item.recommendation) ? item.recommendation : '按处理清单检查输入来源、调用链和现有保护，再选择修复方案。下方保留原文供追溯；新扫描使用中文复核。', verification: hasChinese(item.verification.replace(/^AI 源码复核（未运行代码）：/u, '')) ? item.verification : '原记录为源码复核，没有动态验证或测试执行证据；原始说明保留供追溯。' }
}
