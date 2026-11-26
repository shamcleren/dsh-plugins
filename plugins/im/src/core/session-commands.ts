import { randomUUID } from 'node:crypto'
import type { ConversationBindings } from './conversation-bindings.js'
import { unwrap, type HostApiProxy } from './host-api.js'

export function displayLabel(value: string | undefined, fallback: string, limit = 60): string {
  const points = [...(value?.trim().replace(/\s+/gu, ' ') || fallback)]
  return points.length > limit ? points.slice(0, limit - 1).join('') + '…' : points.join('')
}

export async function runSessionCommand(options: {
  sessions: HostApiProxy['sessions']
  bindings: Pick<ConversationBindings, 'list' | 'set'>
  key: string
  currentSessionId: string
  args: readonly string[]
  titlePrefix: string
}): Promise<string> {
  const { sessions, bindings, key, currentSessionId, args, titlePrefix } = options
  const ids = bindings.list(key, currentSessionId)
  const list = args.length === 0 || args[0] === 'list'
  const pageText = args[0] === 'list' ? args[1] ?? '1' : '1'
  if ((list && (args.length > 2 || !/^[1-9][0-9]*$/u.test(pageText))) || (!list && args.length !== 1)) {
    return '用法：/session、/session <编号或会话 ID>，或 /session list [页码]'
  }
  const roster = unwrap(await sessions.list({ rpcId: `im-session-list-${randomUUID()}`, payload: { sessionIds: ids } })).items
  const known = new Map(roster.map(item => [item.sessionId, item]))
  const title = (id: string) => {
    const value = known.get(id)?.title?.trim()
    return displayLabel(value?.startsWith(titlePrefix) ? value.slice(titlePrefix.length) : value, '新会话（尚无标题）')
  }
  const workspace = (id: string) => `工作区：${displayLabel(known.get(id)?.workspaceTitle, '未分组')}`
  if (!list) {
    const selector = args[0]!
    const target = /^[1-9][0-9]*$/u.test(selector) ? ids[Number(selector) - 1] : selector
    if (target === undefined || !ids.includes(target) || !known.has(target)) {
      return '没有找到当前聊天可切换的会话，可能已归档或删除。发送 /session 查看列表。'
    }
    await bindings.set(key, target)
    return `已切换到会话：${title(target)}（${workspace(target)}）`
  }
  const rows = ids.map((id, index) => ({ id, number: index + 1 })).filter(row => known.has(row.id)).reverse()
  if (rows.length === 0) return '当前聊天还没有历史会话，发送一条消息或 /new 即可开始。'
  const pages = Math.ceil(rows.length / 20), page = Number(pageText)
  if (!Number.isSafeInteger(page) || page > pages) return `没有这一页。发送 /session list <1-${pages}> 查看会话。`
  const entries = rows.slice((page - 1) * 20, page * 20).map(row => {
    const marks = [row.id === currentSessionId ? '当前' : '', known.get(row.id)?.running ? '执行中' : ''].filter(Boolean)
    // Bracketed numbers cannot be renumbered by a Markdown list renderer.
    return `- [${row.number}] ${title(row.id)}${marks.length ? `（${marks.join(' · ')}）` : ''} · ${workspace(row.id)}`
  })
  const navigation = ['切换：/session <编号>', '新建：/new',
    ...(pages > 1 ? [`翻页：/session list ${page < pages ? page + 1 : 1}`] : [])]
  return [`当前聊天的会话（第 ${page}/${pages} 页）；${navigation.join('；')}`, entries.join('\n')].join('\n')
}
