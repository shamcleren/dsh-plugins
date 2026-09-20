import { lstat, realpath, open } from 'node:fs/promises'
import { constants } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'
import { hash, inside } from './repository.js'
import type { Report } from './report.js'
export const ArchiveSchema = z.object({
  snippets: z.array(z.object({ file: z.string().max(2000), start: z.number().int().positive(), lines: z.array(z.string().max(16000)).min(1).max(200), sourceHash: z.string().max(200), redacted: z.boolean() }).strict()).max(5000),
  omitted: z.number().int().nonnegative(),
}).strict()
export type EvidenceArchive = z.infer<typeof ArchiveSchema>
export function redactText(value: string): string {
  return value.replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/gu, value => value.split('\n').map(() => '[敏感内容已隐藏]').join('\n'))
    .replace(/\b(?:sk-[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9_]{16,}|AKIA[A-Z0-9]{16})\b/gu, '[REDACTED]')
    .replace(/((?:api[_-]?key|access[_-]?token|password|secret|authorization)\s*["']?\s*[:=]\s*["'])([^"'\r\n]+)(["'])/giu, '$1[REDACTED]$3')
}
const LIMIT = 2 * 1024 * 1024
/** Archive only bounded, redacted evidence; never export a complete repository. */
export function addExcerpt(archive: EvidenceArchive, report: Report, file: string, start: number, lines: string[]): void {
  const sourceHash = report.source.files[file]
  if (!sourceHash || !lines.length || archive.snippets.some(item => item.file === file && item.start <= start && item.start + item.lines.length >= start + lines.length)) return
  const sensitive = report.findings.some(item => item.engine === 'gitleaks' && item.file === file) || /(?:^|\/)(?:\.env[^/]*|[^/]*\.(?:pem|key|p12|pfx))$/iu.test(file)
  const safe = sensitive ? lines.map(() => '[敏感文件内容已隐藏；请在授权环境核实]') : redactText(lines.join('\n')).split('\n')
  const snippet = { file, start, lines: safe.map(line => line.length > 16000 ? '[此行过长，未收录]' : line), sourceHash, redacted: sensitive || safe.join('\n') !== lines.join('\n') }
  if (archive.snippets.length >= 5000 || Buffer.byteLength(JSON.stringify([...archive.snippets, snippet])) > LIMIT) { archive.omitted++; return }
  archive.snippets.push(snippet)
}
export function mergeArchives(report: Report, additions?: EvidenceArchive): EvidenceArchive {
  const archive: EvidenceArchive = { snippets: [], omitted: (report.evidenceArchive?.omitted ?? 0) + (additions?.omitted ?? 0) }
  for (const item of [...(report.evidenceArchive?.snippets ?? []), ...(additions?.snippets ?? [])]) {
    if (report.source.files[item.file] !== item.sourceHash) throw new Error('Evidence archive does not match scan digest')
    addExcerpt(archive, report, item.file, item.start, item.lines)
    const saved = archive.snippets.at(-1)
    if (saved && saved.file === item.file && saved.start === item.start) saved.redacted ||= item.redacted
  }
  return archive
}
export async function captureScanEvidence(report: Report, root: string): Promise<EvidenceArchive> {
  const archive: EvidenceArchive = { snippets: [], omitted: 0 }
  const directory = await realpath(root)
  for (const file of new Set(report.findings.map(item => item.file))) {
    const target = join(directory, file), stat = await lstat(target)
    if (!Object.hasOwn(report.source.files, file) || !stat.isFile() || stat.isSymbolicLink() || stat.size > 1024 * 1024 || !inside(directory, await realpath(target))) throw new Error('Unsafe evidence source')
    const handle = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW)
    let bytes: Buffer
    try { const buffer = Buffer.alloc(stat.size + 1); const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0); const after = await handle.stat(); if (bytesRead !== stat.size || after.size !== stat.size || after.mtimeMs !== stat.mtimeMs) throw new Error('Evidence source changed while reading'); bytes = buffer.subarray(0, bytesRead) } finally { await handle.close() }
    if (hash(bytes) !== report.source.files[file]) throw new Error('Evidence source changed after scanning')
    const lines = bytes.toString('utf8').split('\n')
    const locations = [...new Set(report.findings.filter(item => item.file === file).map(item => item.line))].sort((a, b) => a - b)
    for (const line of locations) { const start = Math.max(1, line - 8); addExcerpt(archive, report, file, start, lines.slice(start - 1, line + 8)) }
  }
  return archive
}
