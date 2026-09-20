/** Tencent iLink JSON protocol fields used by the channel. */

export const MessageItemType = { TEXT: 1, IMAGE: 2, VOICE: 3, FILE: 4, VIDEO: 5 } as const

/**
 * Media kinds for `getuploadurl`. These are numbered independently of
 * `MessageItemType`, so an image is 1 here and 2 there.
 */
export const UploadMediaType = { IMAGE: 1, VIDEO: 2, FILE: 3, VOICE: 4 } as const

export interface CdnMedia {
  encrypt_query_param?: string
  aes_key?: string
  encrypt_type?: number
  full_url?: string
}

export interface GetUploadUrlResponse {
  ret?: number
  errmsg?: string
  upload_param?: string
  upload_full_url?: string
}

export interface MessageItem {
  type?: number
  msg_id?: string
  text_item?: { text?: string }
  image_item?: { media?: CdnMedia; aeskey?: string; mid_size?: number }
  voice_item?: { media?: CdnMedia; text?: string }
  file_item?: { media?: CdnMedia; file_name?: string }
  video_item?: { media?: CdnMedia }
}

export interface WeixinMessage {
  message_id?: number
  client_id?: string
  from_user_id?: string
  create_time_ms?: number
  item_list?: MessageItem[]
  context_token?: string
}

export interface GetUpdatesResponse {
  ret?: number
  errcode?: number
  errmsg?: string
  msgs?: WeixinMessage[]
  get_updates_buf?: string
  longpolling_timeout_ms?: number
}

export interface QrCodeResponse { qrcode: string; qrcode_img_content: string }
export type QrStatus = 'wait' | 'scaned' | 'confirmed' | 'expired' | 'scaned_but_redirect'
  | 'need_verifycode' | 'verify_code_blocked' | 'binded_redirect'
export interface QrStatusResponse {
  status: QrStatus
  bot_token?: string
  ilink_bot_id?: string
  baseurl?: string
  ilink_user_id?: string
  redirect_host?: string
}

export interface WeChatAccountCredentials {
  accountId: string
  token: string
  baseUrl: string
  userId?: string
}
