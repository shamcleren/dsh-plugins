import { randomBytes, randomUUID } from 'node:crypto'
import type {
  GetUpdatesResponse, GetUploadUrlResponse, MessageItem, QrCodeResponse, QrStatusResponse,
} from './protocol.js'

const API_TIMEOUT_MS = 15_000
const BASE_INFO = { channel_version: '0.1.0', bot_agent: 'DeepSeekHarness/0.1.0' }

/** Structured failures never include response bodies, which can contain credentials. */
export class WeChatSendError extends Error {
  constructor(readonly kind: 'throttled' | 'context' | 'rejected' | 'uncertain', readonly retryAfterMs = 60_000) {
    super(`wechat: message delivery ${kind}`)
  }
}

function headers(token?: string): Record<string, string> {
  const requestHeaders: Record<string, string> = {
    'Content-Type': 'application/json',
    AuthorizationType: 'ilink_bot_token',
    'X-WECHAT-UIN': Buffer.from(String(randomBytes(4).readUInt32BE(0))).toString('base64'),
    'iLink-App-Id': 'bot',
    'iLink-App-ClientVersion': String(1 << 16),
  }
  if (token !== undefined) requestHeaders.Authorization = `Bearer ${token}`
  return requestHeaders
}

function apiUrl(baseUrl: string, endpoint: string): URL {
  return new URL(endpoint, baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`)
}

async function requestText(request: {
  baseUrl: string
  endpoint: string
  method: 'GET' | 'POST'
  token?: string
  body?: unknown
  timeoutMs?: number
  signal?: AbortSignal
}): Promise<string> {
  const timeout = AbortSignal.timeout(request.timeoutMs ?? API_TIMEOUT_MS)
  const signal = request.signal === undefined ? timeout : AbortSignal.any([request.signal, timeout])
  const response = await fetch(apiUrl(request.baseUrl, request.endpoint), {
    method: request.method,
    headers: headers(request.token),
    ...request.body === undefined ? {} : { body: JSON.stringify(request.body) },
    signal,
  })
  const body = await response.text()
  if (!response.ok) throw new Error(`wechat: ${request.endpoint.split('?')[0]} returned HTTP ${response.status}`)
  return body
}

async function postJson<T>(request: {
  baseUrl: string
  endpoint: string
  token?: string
  body: unknown
  timeoutMs?: number
  signal?: AbortSignal
}): Promise<T> {
  return parseProtocolJson(await requestText({ ...request, method: 'POST' })) as T
}

/** Start one official WeChat QR authorization. */
export async function requestQrCode(baseUrl: string, localTokens: readonly string[]): Promise<QrCodeResponse> {
  return await postJson({
    baseUrl,
    endpoint: 'ilink/bot/get_bot_qrcode?bot_type=3',
    body: { local_token_list: localTokens.slice(-10) },
  })
}

/** Poll an authorization status. */
export async function requestQrStatus(
  baseUrl: string,
  qrCode: string,
  verifyCode?: string,
  signal?: AbortSignal,
): Promise<QrStatusResponse> {
  const query = new URLSearchParams({ qrcode: qrCode })
  if (verifyCode !== undefined) query.set('verify_code', verifyCode)
  try {
    return JSON.parse(await requestText({
      baseUrl,
      endpoint: `ilink/bot/get_qrcode_status?${query}`,
      method: 'GET',
      timeoutMs: 35_000,
      ...signal === undefined ? {} : { signal },
    })) as QrStatusResponse
  } catch (error) {
    if (error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError')) {
      return { status: 'wait' }
    }
    throw error
  }
}

/** Wait for new messages using the persisted opaque cursor. */
export async function getUpdates(request: {
  baseUrl: string
  token: string
  cursor: string
  timeoutMs: number
  signal: AbortSignal
}): Promise<GetUpdatesResponse> {
  try {
    return await postJson({
      baseUrl: request.baseUrl,
      endpoint: 'ilink/bot/getupdates',
      token: request.token,
      body: { get_updates_buf: request.cursor, base_info: BASE_INFO },
      timeoutMs: request.timeoutMs,
      signal: request.signal,
    })
  } catch (error) {
    if (error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError')) {
      return { ret: 0, msgs: [], get_updates_buf: request.cursor }
    }
    throw error
  }
}

/**
 * Reserve CDN upload parameters for one outbound media object. The sizes describe
 * the same bytes twice: `rawSize` before AES-128-ECB and `fileSize` after it.
 */
export async function getUploadUrl(request: {
  baseUrl: string
  token: string
  userId: string
  fileKey: string
  mediaType: number
  rawSize: number
  rawFileMd5: string
  fileSize: number
  aesKeyHex: string
  signal?: AbortSignal
}): Promise<GetUploadUrlResponse> {
  const response = await postJson<GetUploadUrlResponse>({
    baseUrl: request.baseUrl,
    endpoint: 'ilink/bot/getuploadurl',
    token: request.token,
    body: {
      filekey: request.fileKey,
      media_type: request.mediaType,
      to_user_id: request.userId,
      rawsize: request.rawSize,
      rawfilemd5: request.rawFileMd5,
      filesize: request.fileSize,
      no_need_thumb: true,
      aeskey: request.aesKeyHex,
      base_info: BASE_INFO,
    },
    ...request.signal === undefined ? {} : { signal: request.signal },
  })
  if (response.ret !== undefined && response.ret !== 0) {
    throw new Error(`wechat: getuploadurl ret=${response.ret}: ${response.errmsg ?? 'unknown error'}`)
  }
  return response
}

/** Send one completed iLink message. */
export async function sendMessage(request: {
  baseUrl: string
  token: string
  userId: string
  contextToken?: string
  item: MessageItem
  signal?: AbortSignal
  clientId?: string
}): Promise<void> {
  let response: { ret?: number; errcode?: number; errmsg?: string }
  try {
    const timeout = AbortSignal.timeout(API_TIMEOUT_MS)
    const result = await fetch(apiUrl(request.baseUrl, 'ilink/bot/sendmessage'), {
      method: 'POST', headers: headers(request.token),
      signal: request.signal === undefined ? timeout : AbortSignal.any([request.signal, timeout]),
      body: JSON.stringify({
        msg: {
          from_user_id: '', to_user_id: request.userId,
          client_id: request.clientId ?? `dsh-wechat-${randomUUID()}`,
          message_type: 2, message_state: 2, item_list: [request.item],
          context_token: request.contextToken,
        },
        base_info: BASE_INFO,
      }),
    })
    if (result.status === 429) {
      const seconds = Number(result.headers.get('retry-after'))
      throw new WeChatSendError('throttled', Number.isFinite(seconds) && seconds > 0
        ? Math.min(seconds * 1_000, 3_600_000) : 60_000)
    }
    if (!result.ok) throw new WeChatSendError(result.status >= 500 ? 'uncertain' : 'rejected')
    response = parseProtocolJson(await result.text()) as typeof response
    if (response === null || typeof response !== 'object' || Array.isArray(response)
      || response.ret !== 0 || (response.errcode !== undefined && response.errcode !== 0)) {
      const reason = typeof response?.errmsg === 'string' ? response.errmsg : ''
      if (response?.ret === -2 || /prepare failed|rate.?limit/iu.test(reason)) throw new WeChatSendError('context')
      if (/context|expired/iu.test(reason)) throw new WeChatSendError('context')
      throw new WeChatSendError(response?.ret === undefined ? 'uncertain' : 'rejected')
    }
  } catch (error) {
    if (error instanceof WeChatSendError) throw error
    throw new WeChatSendError('uncertain')
  }
}

/** Resolve and publish a typing state for one peer. */
export async function sendTyping(request: {
  baseUrl: string
  token: string
  userId: string
  contextToken?: string
  status: 1 | 2
}): Promise<void> {
  const config = await postJson<{ typing_ticket?: string }>({
    baseUrl: request.baseUrl,
    endpoint: 'ilink/bot/getconfig',
    token: request.token,
    body: { ilink_user_id: request.userId, context_token: request.contextToken, base_info: BASE_INFO },
  })
  if (config.typing_ticket === undefined) return
  await postJson({
    baseUrl: request.baseUrl,
    endpoint: 'ilink/bot/sendtyping',
    token: request.token,
    body: {
      ilink_user_id: request.userId,
      typing_ticket: config.typing_ticket,
      status: request.status,
      base_info: BASE_INFO,
    },
  })
}

/** Notify iLink that one account monitor started or stopped. */
export async function notifyLifecycle(
  account: { baseUrl: string; token: string },
  state: 'start' | 'stop',
): Promise<void> {
  await postJson({
    baseUrl: account.baseUrl,
    endpoint: `ilink/bot/msg/notify${state}`,
    token: account.token,
    body: { base_info: BASE_INFO },
    timeoutMs: 10_000,
  })
}

/** iLink identifiers exceed IEEE-754's exact integer range on recent WeChat clients. */
export function parseProtocolJson(text: string): unknown {
  return JSON.parse(text, (key: string, value: unknown, context?: { source?: string }) => {
    if (!['message_id', 'msg_id', 'svr_id'].includes(key) || typeof value !== 'number' || Number.isSafeInteger(value)) return value
    if (context?.source === undefined || !/^[0-9]+$/u.test(context.source)) throw new Error('wechat: invalid numeric message id')
    return context.source
  })
}
