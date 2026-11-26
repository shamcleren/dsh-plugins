import { lstat, readFile } from 'node:fs/promises'
import { z } from 'zod'

const hostname = z.string().toLowerCase().max(253)
  .regex(/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/u)
  .refine(host => host !== 'github.com' && /\.[a-z][a-z0-9-]*$/u.test(host))

const settingsSchema = z.strictObject({
  host: hostname,
  credentialHelper: z.enum(['osxkeychain', 'libsecret', 'manager']),
})
export type HttpsSettings = z.infer<typeof settingsSchema>

export const httpsRepository = z.string().trim().max(512).transform((input, context) => {
  const match = /^https:\/\/([^/]+)\/([A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)+)\/?$/u.exec(input)
  const host = hostname.safeParse(match?.[1])
  const path = match?.[2]?.replace(/\.git$/u, '')
  if (!host.success || !path || path.split('/').some(part => !part || part === '.' || part === '..')) {
    context.addIssue({ code: 'custom', message: 'Invalid HTTPS repository address' })
    return z.NEVER
  }
  return `https://${host.data}/${path}.git`
})

export function httpsRepositoryPath(url: string): string {
  return new URL(url).pathname.slice(1, -4)
}

export async function readHttpsSettings(file: string): Promise<HttpsSettings | undefined> {
  try {
    const info = await lstat(file)
    if (!info.isFile() || info.size > 4096) return undefined
    const settings = settingsSchema.safeParse(JSON.parse(await readFile(file, 'utf8')))
    return settings.success ? settings.data : undefined
  } catch {
    return undefined
  }
}
