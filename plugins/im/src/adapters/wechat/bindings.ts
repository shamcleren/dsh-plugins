import { ConversationBindings as ChannelBindings } from '../../core/conversation-bindings.js'

export type ConversationBindings = ChannelBindings
export const ConversationBindings = {
  open: (filename: string) => ChannelBindings.open(filename, 'wechat'),
}
