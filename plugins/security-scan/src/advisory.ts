import { z } from 'zod'
import type { Finding } from './report.js'
const identifier = z.string().regex(/^[A-Za-z0-9._-]{1,150}$/u)
const Advisory = z.object({
  id: identifier, aliases: z.array(identifier).max(100).default([]), summary: z.string().max(12000).default(''),
  references: z.array(z.object({ url: z.string().max(2000) })).max(100).default([]),
  affected: z.array(z.object({ package: z.object({ name: z.string(), ecosystem: z.string() }),
    ranges: z.array(z.object({ type: z.string(), events: z.array(z.object({ fixed: z.string().max(200).optional() })) })).default([]),
  })).default([]),
})
export async function osvJson(url: string, signal: AbortSignal, init: RequestInit = {}): Promise<unknown> {
  const response = await fetch(url, { ...init, redirect: 'error', signal: AbortSignal.any([signal, AbortSignal.timeout(20000)]) })
  if (!response.ok) throw new Error('OSV query failed')
  const reader = response.body?.getReader(); if (!reader) throw new Error('Empty OSV response')
  let bytes = 0; const chunks: Uint8Array[] = []
  try { while (true) { const chunk = await reader.read(); if (chunk.done) break; bytes += chunk.value.length; if (bytes > 4 * 1024 * 1024) throw new Error('OSV response too large'); chunks.push(chunk.value) } } finally { await reader.cancel() }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}
/** Fetch each public advisory once; failure leaves the original candidate visible. */
export async function enrichAdvisories(findings: Finding[], signal: AbortSignal): Promise<number> {
  const ids = [...new Set(findings.filter(item => item.dependency).map(item => item.rule))]
  let next = 0, unavailable = 0
  await Promise.all(Array.from({ length: Math.min(6, ids.length) }, async () => {
    while (next < ids.length) {
      signal.throwIfAborted()
      const id = ids[next++]!
      let advisory: z.infer<typeof Advisory>
      try { advisory = Advisory.parse(await osvJson('https://api.osv.dev/v1/vulns/' + encodeURIComponent(id), signal)); if (advisory.id !== id) throw new Error('Advisory identity mismatch') }
      catch { signal.throwIfAborted(); unavailable++; continue }
      for (const item of findings.filter(item => item.rule === id && item.dependency)) {
        const dep = item.dependency!
        const normalize = (name: string) => dep.ecosystem === 'PyPI' ? name.toLowerCase().replace(/[-_.]+/gu, '-') : name
        const affected = advisory.affected.filter(entry => entry.package.ecosystem === dep.ecosystem && normalize(entry.package.name) === normalize(dep.name))
        dep.aliases = advisory.aliases
        dep.summary = advisory.summary
        dep.fixedVersions = [...new Set(affected.flatMap(entry => entry.ranges.filter(range => range.type !== 'GIT').flatMap(range => range.events.flatMap(event => event.fixed ? [event.fixed] : []))))].slice(0, 100)
        dep.references = advisory.references.map(ref => ref.url).filter(url => { try { const parsed = new URL(url); return ['http:', 'https:'].includes(parsed.protocol) && !parsed.username && !parsed.password } catch { return false } }).slice(0, 30)
        dep.metadataAvailable = true
        item.recommendation = dep.fixedVersions.length
          ? '公告列出的修复版本：' + dep.fixedVersions.join('、') + '（可能属于不同维护分支）。结合当前版本选择适用分支；统一更新直接依赖约束和锁文件，再运行测试并重新扫描。单个公告的修复版本不保证消除该包的其他漏洞。'
          : '公告未提供可用的包版本修复信息。检查上游公告与补丁，评估升级、替换依赖或暂时禁用可达的受影响功能；保留待复核状态并在修复后重新扫描。'
        item.recommendation += '\nhttps://osv.dev/vulnerability/' + id
      }
    }
  }))
  return unavailable
}
