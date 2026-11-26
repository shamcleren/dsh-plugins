import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import { writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import { conversationKeyFor, type WeComInboundText } from './inbound.js'
import type { WeComGroupDirectory } from './group-directory.js'
import { z } from 'zod'
import { groupName } from '../../contracts.js'

const keySchema = z.string().regex(/^[a-f0-9]{64}$/u)

async function readJson(path: string): Promise<unknown> {
  try { return JSON.parse(await readFile(path, 'utf8')) }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error }
}

async function save(path: string, value: unknown): Promise<void> {
  await writeFileAtomic(path, JSON.stringify(value) + '\n', { mode: 0o600, dirMode: 0o700 })
}

/** Local aliases are scoped to the Bot and the exact group or sender. */
export class WeComSessionSources {
  constructor(private readonly root = join(resolveDshHome(), 'channels', 'wecom-aibot', 'sources')) {}

  private groupPath(key: string): string {
    return join(this.root, 'groups', keySchema.parse(key) + '.json')
  }

  private speakerPath(message: WeComInboundText): string {
    const key = conversationKeyFor({ ...message, chatType: 'single', conversationId: message.userId })
    return join(this.root, 'members', key + '.json')
  }

  async nameSelf(message: WeComInboundText, name: string): Promise<void> {
    await save(this.speakerPath(message), groupName.parse(name))
  }

  async questionNames(message: WeComInboundText, directory?: WeComGroupDirectory) {
    const saved = groupName.optional().parse(await readJson(this.speakerPath(message)))
    const speaker = saved ?? await directory?.name(message.userId, 'single')
    if (message.chatType === 'single') return { speaker }
    const key = conversationKeyFor(message)
    const alias = groupName.optional().parse(await readJson(this.groupPath(key)))
    if (alias) return { speaker, group: alias }
    const fresh = await directory?.name(message.conversationId)
    if (fresh) await this.rememberDirectoryName(key, fresh)
    const group = fresh ?? groupName.optional().parse(await readJson(join(this.root, 'directory', key + '.json')))
    return { speaker, group }
  }

  async nameGroup(key: string, name: string): Promise<void> {
    await save(this.groupPath(key), groupName.parse(name))
  }

  async rememberDirectoryName(key: string, name: string): Promise<void> {
    const path = join(this.root, 'directory', keySchema.parse(key) + '.json')
    const next = groupName.parse(name)
    if (await readJson(path) !== next) await save(path, next)
  }
}
