import { Service, type Context } from '@deepseek-ai/cordis'
import { defineTool, type ToolRunContext } from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-session'
import { WeChatPushError } from './delivery.js'
import type { WeChatDelivery, WeChatPushRequest } from './delivery.js'
export type { WeChatPushRequest, WeChatPushReceipt, WeChatRecipient } from './delivery.js'
export { WeChatPushError } from './delivery.js'

declare module '@deepseek-ai/cordis' {
  interface Context { wechatPush: WeChatPushService }
}

/** Host-local integration for schedulers; no credentials or public HTTP sender. */
export class WeChatPushService extends Service {
  constructor(ctx: Context, private readonly delivery: WeChatDelivery) { super(ctx, 'wechatPush') }

  recipients() { return this.delivery.recipients() }
  notify(request: WeChatPushRequest) { return this.delivery.notify(request) }
  status(id: string) { return this.delivery.status(id) }
  cancel(id: string) { return this.delivery.cancel(id) }
}

export function installPushTools(ctx: Context, delivery: WeChatDelivery): void {
  ctx.inject(['tools'], scope => {
    const callerSession = (exec: ToolRunContext): string | undefined => {
      let session = exec.agent?.session
      const visited = new Set<string>()
      while (session?.header.parentSession) {
        if (visited.has(session.id) || visited.size >= 64) throw new WeChatPushError('session-lineage-unavailable')
        visited.add(session.id)
        const parent = session.header.parentSession
        if (String(parent).startsWith('session-wechat-')) return parent
        session = scope.get('sessions')?.get(parent)
        if (!session) throw new WeChatPushError('session-lineage-unavailable')
      }
      return session?.id
    }
    const output = { schema: { type: 'json' as const },
      render: (_args: unknown, value: unknown) => [{ type: 'text' as const, text: JSON.stringify(value) }] }
    scope.tools.register(defineTool({
      name: 'wechat_recipients',
      description: 'List previously contacted WeChat recipients and whether their interaction window is open. Contains accountId and recipientId, never credentials. Use before wechat_notify when choosing among multiple accounts. A WeChat session sees only its own recipient.',
      parameters: {}, output,
      async execute(_args, exec) { return delivery.recipients(callerSession(exec)).map(peer => ({ ...peer })) },
    }))
    scope.tools.register(defineTool({
      name: 'wechat_notify',
      description: 'Queue a text notification to WeChat, for task results or scheduled work explicitly requested by the user. A WeChat session can notify only its own peer; another session defaults to the scanning owner only when unambiguous. With multiple accounts choose accountId or recipientId from wechat_recipients. Returns queued, not delivered: use wechat_notification_status to inspect a receipt. Do not poll repeatedly. Never retry an uncertain delivery with a new key. Ordinary WeChat replies are sent automatically.',
      parameters: {
        text: { type: 'string', required: true, description: 'Nonempty text, at most 16000 UTF-16 code units.' },
        recipientId: { type: 'string', description: 'Exact recipientId returned by wechat_recipients.' },
        accountId: { type: 'string', description: 'Exact accountId; without recipientId selects that account owner.' },
        idempotencyKey: { type: 'string', description: 'Stable key for one notification or one schedule occurrence; reuse it on retries.' },
      }, output,
      async execute(args, exec) {
        return { ...await delivery.notify({ ...args, idempotencyKey: args.idempotencyKey ?? String(exec.callId) },
          callerSession(exec), exec.signal) }
      },
    }))
    scope.tools.register(defineTool({
      name: 'wechat_notification_status', description: 'Read the delivery status of a notification created by this session. sent means iLink accepted all chunks, not that the user read them. uncertain requires manual verification before any resend.',
      parameters: { id: { type: 'string', required: true } }, output,
      async execute(args, exec) { return { ...delivery.status(args.id, callerSession(exec)) } },
    }))
    scope.tools.register(defineTool({
      name: 'wechat_notification_cancel', description: 'Cancel a queued notification created by this session. A send already dispatched cannot be recalled.',
      parameters: { id: { type: 'string', required: true } }, output,
      async execute(args, exec) { exec.signal.throwIfAborted(); return { ...await delivery.cancel(args.id, callerSession(exec)) } },
    }))
  })
}
