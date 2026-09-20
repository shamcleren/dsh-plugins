/** Codex notices become conversation nodes. Chat still renders the same events as context messages. */
import type { ConversationNodeDefinition, ConversationViewBuilder, ConversationViewDefinition, ConversationViewNode } from '@deepseek-ai/dsh-client-ui-conversation/client'
import { PLUGIN } from './transcript.js'

export const CODEX_TARGET = 'codex'
export interface CodexNoticeNode { summary: string; text: string; seq: number }

type NoticeEvent = { type?: string; seq?: number; data?: { source?: { kind?: string; plugin?: string; summary?: string }; content?: Array<{ type?: string; text?: string }> } }

export function codexNoticeDefinition(): ConversationNodeDefinition<CodexNoticeNode> {
  return {
    kind: 'codex-notice',
    target: CODEX_TARGET,
    match(event) {
      const notice = readNotice(event as NoticeEvent)
      return notice ? { id: 'codex-notice:' + String(event.seq ?? notice.text), role: 'start' } : null
    },
    start(_context, match) {
      return readNotice(match.event as NoticeEvent) ?? { summary: 'Codex', text: '', seq: Number(match.event.seq) }
    },
    update(context) { return context.state },
    buildViewNode(context) {
      if (!context.state) return null
      return { key: context.key, kind: 'codex-notice', id: context.id, target: CODEX_TARGET, data: context.state }
    },
  }
}

export function codexViewDefinition(): ConversationViewDefinition<ConversationViewNode, { nodes: readonly CodexNoticeNode[] }> {
  return {
    target: CODEX_TARGET,
    create(): ConversationViewBuilder<ConversationViewNode, { nodes: readonly CodexNoticeNode[] }> {
      let nodes: readonly CodexNoticeNode[] = []
      const adopt = (incoming: readonly ConversationViewNode[]): { nodes: readonly CodexNoticeNode[] } => {
        const next = new Map(nodes.map(node => ['codex-notice:' + node.seq, node]))
        for (const item of incoming) if (isNotice(item.data)) next.set(item.id, item.data)
        nodes = [...next.values()]
        return { nodes }
      }
      return { empty: { nodes }, replace: input => adopt(input.nodes), apply: input => adopt(input.upserts) }
    },
    isActive(snapshot) { return snapshot.nodes.length > 0 },
  }
}

export function readNotice(event: NoticeEvent): CodexNoticeNode | undefined {
  if (event.type !== 'user/message' || event.data?.source?.kind !== 'plugin' || event.data.source.plugin !== PLUGIN) return
  const text = (event.data.content ?? []).filter(block => block.type === 'text').map(block => block.text ?? '').join('\n').trim()
  if (!text) return
  return { summary: event.data.source.summary || 'Codex', text, seq: event.seq ?? 0 }
}

function isNotice(value: unknown): value is CodexNoticeNode {
  return value !== null && typeof value === 'object' && typeof (value as CodexNoticeNode).text === 'string'
}
