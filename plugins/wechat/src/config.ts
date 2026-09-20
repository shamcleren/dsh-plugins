import z from '@deepseek-ai/schemastery'

export const DEFAULT_BASE_URL = 'https://ilinkai.weixin.qq.com'
export const DEFAULT_CDN_BASE_URL = 'https://novac2c.cdn.weixin.qq.com/c2c'
export const DEFAULT_THINKING_TEXT = '正在思考…'
export const DEFAULT_TURN_TIMEOUT_MS = 300_000
export const DEFAULT_WORKSPACE_NAME = '微信机器人'
export const DEFAULT_MEDIA_MAX_BYTES = 20 * 1024 * 1024

/** Settings for Tencent iLink-backed personal WeChat accounts. */
export interface Config {
  workspaceName?: string
  workspaceId?: string
  preventIdleSleep?: boolean
  agentPreset?: string
  thinkingText?: string
  turnTimeoutMs?: number
  mediaMaxBytes?: number
  sendTyping?: boolean
}

export const Config: z<Config> = z.object({
  workspaceName: z.string().min(1).default(DEFAULT_WORKSPACE_NAME),
  workspaceId: z.string().min(1),
  preventIdleSleep: z.boolean().default(false),
  agentPreset: z.string().min(1),
  thinkingText: z.string().min(1).default(DEFAULT_THINKING_TEXT),
  turnTimeoutMs: z.number().step(1).min(1_000).default(DEFAULT_TURN_TIMEOUT_MS),
  mediaMaxBytes: z.number().step(1).min(1_024).default(DEFAULT_MEDIA_MAX_BYTES),
  sendTyping: z.boolean().default(true),
})

/**
 * Channel policy a chat command may persist into this plugin's settings section.
 * An explicit `undefined` clears the field so it falls back to the deployment's
 * own default, which a merge-only patch cannot express.
 */
export interface WeChatSettingsPatch {
  agentPreset?: string | undefined
}

export interface WeChatRuntimeConfig {
  adminUsers: readonly string[]
  agentPreset?: string
  thinkingText: string
  turnTimeoutMs: number
  mediaMaxBytes: number
  sendTyping: boolean
}

/** Resolve validated settings for an active account runtime. */
export function resolveRuntimeConfig(config: Config, ownerId?: string): WeChatRuntimeConfig {
  const owner = ownerId?.trim() ? [ownerId] : []
  return {
    adminUsers: owner,
    ...config.agentPreset === undefined ? {} : { agentPreset: config.agentPreset },
    thinkingText: config.thinkingText ?? DEFAULT_THINKING_TEXT,
    turnTimeoutMs: config.turnTimeoutMs ?? DEFAULT_TURN_TIMEOUT_MS,
    mediaMaxBytes: config.mediaMaxBytes ?? DEFAULT_MEDIA_MAX_BYTES,
    sendTyping: config.sendTyping ?? true,
  }
}
