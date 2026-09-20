import z from '@deepseek-ai/schemastery'

export const DEFAULT_BOT_ID_ENV = 'WECOM_BOT_ID'
export const DEFAULT_SECRET_ENV = 'WECOM_BOT_SECRET'
export const DEFAULT_THINKING_TEXT = '正在思考…'
export const DEFAULT_TURN_TIMEOUT_MS = 300_000
export const DEFAULT_WORKSPACE_NAME = '企业微信机器人'

/** Settings used to authenticate and run one WeCom Bot account. */
export interface Config {
  /** Credential reference containing the WeCom Bot ID. */
  botIdEnv?: string
  /** Credential reference containing the WeCom Bot secret. */
  secretEnv?: string
  /** Optional userid allowlist; empty accepts every user visible to the Bot. */
  allowedUsers?: string[]
  /** Userids allowed to run channel management commands. */
  adminUsers?: string[]
  /** Title of the managed fallback Workspace created when workspaceId is omitted. */
  workspaceName?: string
  /** Existing Harness Workspace selected as the default for new conversations. */
  workspaceId?: string
  /** Prevent idle system sleep while the Bot runtime is active on macOS. */
  preventIdleSleep?: boolean
  /** Optional Harness agent preset selected for new WeCom conversations. */
  agentPreset?: string
  /** Initial stream content sent while the Harness turn starts. */
  thinkingText?: string
  /** Maximum time to observe one admitted Harness turn. */
  turnTimeoutMs?: number
}
export const Config: z<Config> = z.object({
  botIdEnv: z.string().min(1).role('credential-ref').default(DEFAULT_BOT_ID_ENV),
  secretEnv: z.string().min(1).role('credential-ref').default(DEFAULT_SECRET_ENV),
  allowedUsers: z.array(z.string().min(1)).default([]),
  adminUsers: z.array(z.string().min(1)).default([]),
  workspaceName: z.string().min(1).default(DEFAULT_WORKSPACE_NAME),
  workspaceId: z.string().min(1),
  preventIdleSleep: z.boolean().default(false),
  agentPreset: z.string().min(1),
  thinkingText: z.string().min(1).default(DEFAULT_THINKING_TEXT),
  turnTimeoutMs: z.number().step(1).min(1_000).default(DEFAULT_TURN_TIMEOUT_MS),
})

/**
 * Channel policy a chat command may persist into this plugin's settings section.
 * An explicit `undefined` clears the field so it falls back to the deployment's
 * own default, which a merge-only patch cannot express.
 */
export interface WeComSettingsPatch {
  agentPreset?: string | undefined
}

/** Resolved credentials detached from the ambient environment. */
export interface WeComCredentials {
  botId: string
  secret: string
}

/** Runtime policy resolved from the validated plugin configuration. */
export interface WeComRuntimeConfig {
  allowedUsers: readonly string[]
  adminUsers: readonly string[]
  agentPreset?: string
  thinkingText: string
  turnTimeoutMs: number
}

/** Resolve optional channel policy defaults for direct programmatic callers. */
export function resolveRuntimeConfig(config: Config): WeComRuntimeConfig {
  return {
    allowedUsers: config.allowedUsers ?? [],
    adminUsers: config.adminUsers ?? [],
    ...config.agentPreset === undefined ? {} : { agentPreset: config.agentPreset },
    thinkingText: config.thinkingText ?? DEFAULT_THINKING_TEXT,
    turnTimeoutMs: config.turnTimeoutMs ?? DEFAULT_TURN_TIMEOUT_MS,
  }
}
