import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import { writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import { z } from 'zod'
import { wecomSessionId, groupName } from '../../contracts.js'

const keySchema = z.string().regex(/^[a-f0-9]{64}$/u)
const account = z.string().trim().min(1).max(256)
const sourceSchema = z.object({ group: keySchema, speakers: z.array(account) })

async function readJson(path: string): Promise<unknown> {
  try { return JSON.parse(await readFile(path, 'utf8')) }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error }
}

async function save(path: string, value: unknown): Promise<void> {
  await writeFileAtomic(path, JSON.stringify(value) + '\n', { mode: 0o600, dirMode: 0o700 })
}

/** Group aliases span sessions. Speaker lists belong only to the session where they spoke. */
export class WeComSessionSources {
  constructor(private readonly root = join(resolveDshHome(), 'channels', 'wecom-aibot', 'sources')) {}

  private sessionPath(id: string): string {
    return join(this.root, 'sessions', wecomSessionId.parse(id) + '.json')
  }

  private groupPath(key: string): string {
    return join(this.root, 'groups', keySchema.parse(key) + '.json')
  }

  // The router serializes admissions for each Bot/conversation key.
  async record(id: string, group: string, speaker: string): Promise<void> {
    const path = this.sessionPath(id)
    const previous = sourceSchema.optional().parse(await readJson(path))
    if (previous && previous.group !== group) throw new Error('WeCom Session source conflict')
    if (previous?.speakers.includes(speaker)) return
    await save(path, sourceSchema.parse({ group, speakers: [...(previous?.speakers ?? []), speaker] }))
  }

  async nameGroup(key: string, name: string): Promise<void> {
    await save(this.groupPath(key), groupName.parse(name))
  }

  async rememberDirectoryName(key: string, name: string): Promise<void> {
    const path = join(this.root, 'directory', keySchema.parse(key) + '.json')
    const next = groupName.parse(name)
    if (await readJson(path) !== next) await save(path, next)
  }

  async get(id: string) {
    const source = sourceSchema.optional().parse(await readJson(this.sessionPath(id)))
    if (!source) return null
    const name = groupName.optional().parse(await readJson(this.groupPath(source.group)))
    const discovered = name ?? groupName.optional().parse(await readJson(join(this.root, 'directory', source.group + '.json')))
    return { group: discovered ?? '#' + source.group.slice(0, 10), speakers: source.speakers }
  }
}
