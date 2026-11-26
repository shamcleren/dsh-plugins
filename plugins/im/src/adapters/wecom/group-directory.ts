import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { z } from 'zod'
import { groupName } from '../../contracts.js'

const exec = promisify(execFile)
const group = z.object({ chat_id: z.string().min(1), chat_name: groupName, chat_type: z.literal('group') })
const sessions = z.object({ sessions: z.array(z.unknown()) })

async function listRecent(): Promise<unknown> {
  const { stdout } = await exec('wecom-cli', ['message', 'aibot', 'sessions', 'list'], {
    timeout: 4_000, maxBuffer: 256 * 1024, encoding: 'utf8',
  })
  return JSON.parse(stdout)
}

/** A local, authorized CLI may identify a group absent from the SDK callback. */
export class WeComGroupDirectory {
  private cached: { until: number; rows: Promise<Map<string, Set<string>>> } | undefined

  constructor(private readonly list = listRecent) {}

  async name(chatId: string): Promise<string | undefined> {
    if (!this.cached || this.cached.until <= Date.now()) {
      const rows = this.list().then(data => {
        const names = new Map<string, Set<string>>()
        for (const value of sessions.parse(data).sessions) {
          const row = group.safeParse(value)
          if (!row.success) continue
          const { chat_id, chat_name } = row.data
          const candidates = names.get(chat_id) ?? new Set<string>()
          candidates.add(chat_name)
          names.set(chat_id, candidates)
        }
        return names
      }).catch(() => new Map<string, Set<string>>())
      this.cached = { until: Date.now() + 60_000, rows }
    }
    const names = (await this.cached.rows).get(chatId)
    return names?.size === 1 ? [...names][0] : undefined
  }
}
