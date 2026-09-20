import { readFile, writeFile, lstat } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { z } from 'zod'
import { parse as parseYaml } from 'yaml'
import { enrichAdvisories, osvJson } from './advisory.js'
import { executable } from './scanner.js'
import { runScanner } from './process.js'
import { hash, type Snapshot } from './repository.js'
import type { Finding, Report } from './report.js'

type Engine = Report['engines'][number]
export const GITLEAKS_VERSION = '8.24.2'
export const recommendation = (rule: string): string => {
  if (/shell/u.test(rule)) return '避免将外部输入拼接为 shell 命令；使用固定可执行文件和参数数组，并约束可选参数。补充恶意参数回归测试。'
  if (/sql/u.test(rule)) return '使用参数化 SQL，将表名等无法绑定的标识符限制为明确允许的集合；验证跨租户访问。'
  if (/tls/u.test(rule)) return '启用证书和主机名验证，配置受信任证书链；为错误证书添加拒绝用例。'
  if (/html/u.test(rule)) return '优先使用 textContent；必须输出 HTML 时采用与上下文匹配的可信净化策略，并验证事件属性和危险 URL。'
  if (/pickle|yaml/u.test(rule)) return '对不可信数据使用安全数据格式或安全加载器，禁止实例化任意类型；增加恶意输入测试。'
  return '追踪输入来源和调用者，移除动态代码执行或改为受限的数据解析；补充越权和恶意输入测试。'
}
export async function enrich(snapshot: Snapshot, item: { rule: string; file: string; line: number; title: string; cwe: string; anchor?: string }, engine = 'semgrep'): Promise<Finding> {
  const lines = (await readFile(join(snapshot.path, item.file), 'utf8')).split('\n')
  if (item.line > lines.length) throw new Error('Finding line outside scanned file')
  const normalized = (lines[item.line - 1] ?? '').trim().replace(/\s+/gu, ' ')
  const { anchor, ...metadata } = item
  const fingerprint = hash(engine + ':' + item.rule + ':' + (anchor ?? hash(normalized)))
  return { ...metadata, id: hash(engine + ':' + item.rule + ':' + item.file + ':' + item.line).slice(0, 24), fingerprint, engine, severity: 'medium', status: 'needs-review', change: 'unknown',
    evidence: '规则命中位于此文件行；尚未证明攻击者可控输入和可达调用链。', recommendation: recommendation(item.rule), verification: '待 DSH security-review 源码复核；未执行项目或漏洞载荷。' }
}
export async function scanSecrets(snapshot: Snapshot, originalRoot: string, binaryName: string, signal: AbortSignal): Promise<{ engine: Engine; findings: Finding[] }> {
  const engine: Engine = { name: 'gitleaks', version: GITLEAKS_VERSION, status: 'unavailable', detail: '密钥扫描器缺失；未执行密钥检查。' }
  const binary = await executable(binaryName, originalRoot)
  if (!binary) return { engine, findings: [] }
  try {
    const version = await runScanner(binary, ['version'], snapshot.path, signal)
    if (version.code || version.stdout.trim().replace(/^v/u, '') !== GITLEAKS_VERSION) return { engine: { ...engine, detail: '仅验证 Gitleaks ' + GITLEAKS_VERSION + '，当前扫描器版本不匹配。' }, findings: [] }
    const config = join(snapshot.path, '../gitleaks.toml'), output = join(snapshot.path, '../gitleaks.json')
    await writeFile(config, '[extend]\nuseDefault = true\n', { mode: 0o600 })
    const result = await runScanner(binary, ['dir', '.', '--config', config, '--report-format', 'json', '--report-path', output, '--redact=100', '--no-banner', '--exit-code=1'], snapshot.path, signal)
    if (![0, 1].includes(result.code)) throw new Error('Secret scanner failed')
    if ((await lstat(output)).size > 16 * 1024 * 1024) throw new Error('Secret scanner report too large')
    const rows = z.array(z.object({ RuleID: z.string(), File: z.string(), StartLine: z.number().int().positive() })).max(2000).parse(JSON.parse(await readFile(output, 'utf8')))
    const findings: Finding[] = []
    for (const row of rows) {
      const file = row.File.replace(/^\.\//u, '')
      if (!Object.hasOwn(snapshot.files, file)) throw new Error('Secret scanner path outside snapshot')
      const item = await enrich(snapshot, { file, line: row.StartLine, rule: row.RuleID, cwe: 'CWE-798', title: '疑似凭据泄漏（已脱敏）' }, 'gitleaks')
      findings.push({ ...item, severity: 'high', evidence: '专用密钥规则命中；报告不保存匹配内容。需确认是否真实、有效且曾进入版本历史。', recommendation: '若凭据真实，立即吊销或轮换并改用凭据服务；仅删除代码中的值不能撤销已泄漏的凭据。', verification: '未尝试使用或验证凭据。' })
    }
    return { engine: { ...engine, status: 'completed', detail: '扫描受限文件快照（含隐藏配置文件）；不扫描 Git 历史，不使用项目自带检测配置。' }, findings }
  } catch (error) { signal.throwIfAborted(); return { engine: { ...engine, status: 'failed', detail: '密钥扫描失败；原始输出未写入报告。' }, findings: [] } }
}
interface Dependency { name: string; version: string; ecosystem: 'npm' | 'Go' | 'PyPI'; file: string; line?: number }
export async function dependencies(snapshot: Snapshot): Promise<{ packages: Dependency[]; unsupported: string[] }> {
  const packages: Dependency[] = [], unsupported: string[] = []
  const add = (dep: Dependency): void => { if (dep.name.length < 300 && dep.version.length < 200 && !/\s/u.test(dep.name + dep.version)) packages.push(dep) }
  for (const file of Object.keys(snapshot.files)) {
    const name = basename(file)
    if (name === 'package-lock.json') {
      try {
        const lock = z.object({ lockfileVersion: z.number(), packages: z.record(z.string(), z.object({ name: z.string().optional(), version: z.string().optional(), link: z.boolean().optional() })) }).parse(JSON.parse(await readFile(join(snapshot.path, file), 'utf8')))
        for (const [path, pkg] of Object.entries(lock.packages)) if (path && pkg.version && !pkg.link && path.includes('node_modules/')) add({ name: pkg.name ?? path.slice(path.lastIndexOf('node_modules/') + 13), version: pkg.version, ecosystem: 'npm', file })
      } catch { unsupported.push(file) }
    } else if (name === 'pnpm-lock.yaml') {
      try {
        const lock = z.object({ lockfileVersion: z.union([z.string(), z.number()]), packages: z.record(z.string(), z.unknown()) }).parse(parseYaml(await readFile(join(snapshot.path, file), 'utf8'), { maxAliasCount: 20 }))
        if (Number(lock.lockfileVersion) < 9) throw new Error('Unsupported pnpm lock version')
        for (const key of Object.keys(lock.packages)) {
          const match = /^(@?[^@]+)@([^()]+)(?:\(.*\))?$/u.exec(key)
          if (!match || !/^\d/u.test(match[2]!)) { unsupported.push(file); continue }
          add({ name: match[1]!, version: match[2]!, ecosystem: 'npm', file })
        }
      } catch { unsupported.push(file) }
    } else if (name === 'go.sum') {
      for (const [index, line] of (await readFile(join(snapshot.path, file), 'utf8')).split('\n').entries()) {
        const match = /^(\S+) (v\S+) h1:/u.exec(line)
        if (match && !match[2]!.endsWith('/go.mod')) add({ name: match[1]!, version: match[2]!, ecosystem: 'Go', file, line: index + 1 })
      }
    } else if (/^requirements[^/]*\.txt$/u.test(name)) {
      for (const [index, line] of (await readFile(join(snapshot.path, file), 'utf8')).split('\n').entries()) {
        if (!line.trim() || line.trim().startsWith('#')) continue
        const match = /^\s*([A-Za-z0-9_.-]+)(?:\[[^\]]+\])?==([A-Za-z0-9_.+!-]+)\s*(?:#.*)?$/u.exec(line)
        if (match) add({ name: match[1]!.toLowerCase().replace(/[-_.]+/gu, '-'), version: match[2]!, ecosystem: 'PyPI', file, line: index + 1 })
        else unsupported.push(file)
      }
    } else if (['yarn.lock', 'uv.lock', 'poetry.lock', 'Pipfile.lock'].includes(name)) unsupported.push(file)
    else if (name === 'package.json' && !Object.hasOwn(snapshot.files, file.replace(/package.json$/u, 'package-lock.json')) && !Object.hasOwn(snapshot.files, file.replace(/package.json$/u, 'pnpm-lock.yaml'))) unsupported.push(file)
    else if (name === 'go.mod' && !Object.hasOwn(snapshot.files, file.replace(/go.mod$/u, 'go.sum'))) unsupported.push(file)
    else if (name === 'pyproject.toml') unsupported.push(file)
  }
  return { packages: [...new Map(packages.map(dep => [JSON.stringify(dep), dep])).values()], unsupported: [...new Set(unsupported)] }
}
/** Explicit opt-in sends only package names and versions to the official OSV API. */
export async function scanDependencies(snapshot: Snapshot, signal: AbortSignal): Promise<{ engine: Engine; findings: Finding[] }> {
  const found = await dependencies(snapshot), findings: Finding[] = []
  const engine: Engine = { name: 'osv', version: 'querybatch-v1', status: 'completed', detail: '检查 npm package-lock v2/v3、pnpm lock v9、Go go.sum、Python requirements 精确版本；依赖是否可达仍需复核。' }
  if (found.unsupported.length) { engine.status = 'partial'; engine.detail += ' 未解析或未锁定：' + found.unsupported.slice(0, 50).join(', ') }
  try {
    // Query unique package/version pairs once, then retain each manifest occurrence.
    const key = (dep: Dependency): string => dep.ecosystem + ':' + dep.name + '@' + dep.version
    const deps = [...new Map(found.packages.map(dep => [key(dep), dep])).values()]
    for (let offset = 0; offset < deps.length; offset += 100) {
      const batch = deps.slice(offset, offset + 100)
      const result = z.object({ results: z.array(z.object({ vulns: z.array(z.object({ id: z.string().regex(/^[A-Za-z0-9._-]{1,150}$/u) })).optional(), next_page_token: z.string().optional() })) }).parse(await osvJson('https://api.osv.dev/v1/querybatch', signal, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ queries: batch.map(dep => ({ package: { name: dep.name, ecosystem: dep.ecosystem }, version: dep.version })) }) }))
      if (result.results.length !== batch.length) throw new Error('OSV result count mismatch')
      for (const [index, row] of result.results.entries()) {
        if (row.next_page_token) { engine.status = 'partial'; engine.detail += ' OSV 分页结果超出本轮覆盖。' }
        for (const dep of found.packages.filter(dep => key(dep) === key(batch[index]!))) {
        for (const vuln of row.vulns ?? []) {
          if (findings.length >= 2000) { engine.status = 'partial'; engine.detail += ' 漏洞记录超过 2000 条上限。'; break }
          const fingerprint = hash(dep.ecosystem + ':' + dep.name + ':' + vuln.id)
          findings.push({ id: hash(dep.file + ':' + dep.version + ':' + fingerprint).slice(0, 24), fingerprint, engine: 'osv', rule: vuln.id, file: dep.file, line: dep.line ?? 1, dependency: { name: dep.name, version: dep.version, ecosystem: dep.ecosystem, advisoryId: vuln.id, aliases: [], fixedVersions: [], summary: '', references: [], metadataAvailable: false, locationExact: dep.line !== undefined }, title: dep.name + '@' + dep.version + ' — ' + vuln.id, cwe: '', severity: 'medium', status: 'needs-review', change: 'unknown', evidence: 'OSV 数据库将锁定版本关联到漏洞公告；未验证依赖在应用中的可达性。', recommendation: '查看 https://osv.dev/vulnerability/' + vuln.id + ' 的受影响和修复版本，升级锁文件并运行相关测试；不猜测修复版本。', verification: '官方 OSV 数据库查询；未运行应用。' + (dep.line ? '位置指向精确版本声明。' : '此格式暂无精确行映射，位置指向清单首行。') })
        }
      }
    }
    }
    const missing = await enrichAdvisories(findings, signal)
    if (missing) engine.detail += ' ' + missing + ' 个公告的详情暂不可用；保留候选，不推断别名或修复版本。'
    if (!deps.length) { engine.status = 'partial'; engine.detail += ' 没有可查询的精确依赖版本。' }
  } catch { signal.throwIfAborted(); engine.status = 'failed'; engine.detail += ' 查询失败或响应不完整，不能据此判定依赖安全。' }
  return { engine, findings }
}
