/** Visible sidebar mark for personal WeChat sessions. */
export const CHANNEL_TITLE_MARK = '【微信】'
/** Durable Session id prefix owned by this channel. */
export const CHANNEL_SESSION_PREFIX = 'session-wechat-'
const UNTITLED = '新会话'

/** Whether this Session was created by the personal WeChat channel. */
export function isChannelSession(sessionId: string): boolean {
  return sessionId.startsWith(CHANNEL_SESSION_PREFIX)
}

/** Prefix a title without duplicating the channel mark. */
export function channelTitle(title = ''): string {
  const topic = title.trim()
  if (topic.startsWith(CHANNEL_TITLE_MARK)) return topic
  return CHANNEL_TITLE_MARK + (topic || UNTITLED)
}
