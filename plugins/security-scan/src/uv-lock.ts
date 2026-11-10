import { parse } from 'smol-toml'
import { z } from 'zod'

const packageName = z.string().max(299).regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/u)
const packageVersion = z.string().max(199).regex(/^[A-Za-z0-9][A-Za-z0-9._+!-]*$/u)
const entrySchema = z.object({ name: packageName, version: packageVersion.optional(), source: z.record(z.string(), z.unknown()) })
const lockSchema = z.object({ version: z.literal(1), package: z.array(z.unknown()).max(10000) })

/** Read uv schema v1 without resolving markers, following URLs, or importing project metadata. */
export function parseUvLock(text: string): { packages: Array<{ name: string; version: string }>; projects: string[]; unsupported: number } {
  const lock = lockSchema.parse(parse(text))
  const packages = new Map<string, { name: string; version: string }>(), projects: string[] = []
  let unsupported = 0
  for (const raw of lock.package) {
    const result = entrySchema.safeParse(raw)
    if (!result.success) { unsupported++; continue }
    const entry = result.data, source = Object.entries(entry.source)
    if (source.length !== 1 || typeof source[0]![1] !== 'string' || !source[0]![1]) { unsupported++; continue }
    const [kind, location] = source[0]! as [string, string]
    if (['editable', 'virtual', 'directory'].includes(kind)) { projects.push(location); continue }
    if (kind !== 'registry' || !entry.version) { unsupported++; continue }
    const name = entry.name.toLowerCase().replace(/[-_.]+/gu, '-')
    packages.set(name + '@' + entry.version, { name, version: entry.version })
  }
  return { packages: [...packages.values()], projects, unsupported }
}
