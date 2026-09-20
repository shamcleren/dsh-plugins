import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-api-session-controller'
import { SessionId } from '@deepseek-ai/dsh-session'
import { channelTitle, isChannelSession } from './channel-id.js'

export { CHANNEL_SESSION_PREFIX, CHANNEL_TITLE_MARK, channelTitle, isChannelSession } from './channel-id.js'

function titleFromEventData(data: unknown): string {
  if (data !== null && typeof data === 'object' && 'title' in data
    && typeof (data as { title: unknown }).title === 'string') {
    return (data as { title: string }).title
  }
  return ''
}

/**
 * Keep channel Sessions marked after DSH writes an automatic title.
 * `sessionController.rename` pins the result, so this waits for a real title
 * instead of naming a blank Session `【微信】新会话` and blocking later titles.
 */
export function installChannelTitle(ctx: Context, logger: { warn(message: string): void }): void {
  ctx.on('session/event', (session, event) => {
    if (event?.type !== 'session/title' || !isChannelSession(String(session.id))) return
    const title = titleFromEventData(event.data).trim()
    if (title === '') return
    const next = channelTitle(title)
    if (next === title) return
    void ctx.sessionController.rename({ sessionId: SessionId(session.id), title: next })
      .catch((error: unknown) => { logger.warn(`wechat: channel title prefix failed: ${String(error)}`) })
  }, { global: true })
}
