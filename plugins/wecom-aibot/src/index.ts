import type {} from '@deepseek-ai/cordis-plugin-loader'
import type { Config as PlainConfig } from './config.js'
import { type Volatile, type Context } from '@deepseek-ai/cordis'
import { installChannelApproval } from './approval.js'
import { installChannelTitle } from './channel-title.js'
import type {} from '@deepseek-ai/dsh-attachment'
import type {} from '@deepseek-ai/dsh-settings'
import { WSClient } from '@wecom/aibot-node-sdk'
import { Config as ConfigSchema, configuredBots, DEFAULT_BOT_ID_ENV, DEFAULT_SECRET_ENV, DEFAULT_WORKSPACE_NAME } from './config.js'
import type { WeComSettingsPatch } from './config.js'
import { onCredentialsUpdated, resolveCredentials } from './credentials.js'
import { createHostApi } from './host-api.js'
import { WeComRuntimeController } from './runtime.js'
import { ConversationBindings } from './bindings.js'
import { resolveDefaultWorkspace } from './workspace.js'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import { join } from 'node:path'
import { readPresentedFile } from './files.js'

export { WeComBotAccount } from './account.js'
export type { WeComBotClient } from './account.js'
export const Config = ConfigSchema.volatile()
export {
  DEFAULT_BOT_ID_ENV,
  DEFAULT_SECRET_ENV,
  DEFAULT_THINKING_TEXT,
  DEFAULT_TURN_TIMEOUT_MS,
  DEFAULT_WORKSPACE_NAME,
} from './config.js'
export type {
  Config as WeComAiBotConfig,
  WeComCredentials,
} from './config.js'

/** Stable Cordis plugin name. */
export const name = 'wecom-aibot'

/** Host gateway required for durable session and turn orchestration. */
export const inject = ['sessionController', 'workspaceRegistry', 'sessions']

/** User-settings namespace that keeps this installed plugin configurable while disconnected. */
export const WECOM_AIBOT_SETTINGS_NAMESPACE = 'wecom-aibot'

/** Connect one configured WeCom Bot for the lifetime of this plugin fiber. */
export function apply(ctx: Context, config: PlainConfig | Volatile<PlainConfig>): void {
  const api = createHostApi(ctx,
    sessionId => runtime.routesSession(sessionId),
    sessionId => runtime.observesSession(sessionId))
  const logger = ctx.logger(name)
  installChannelTitle(ctx, logger)
  // Cloning detaches the validated readonly snapshot for existing mutable config consumers.
  const settings = (): PlainConfig => ('get' in config) ? structuredClone(config.get()) as PlainConfig : config
  let bindings: Promise<ConversationBindings> | undefined
  const bindingStore = (): Promise<ConversationBindings> => {
    bindings ??= ConversationBindings.open(join(
      resolveDshHome(), 'channels', 'wecom-aibot', 'bindings.json'))
    return bindings
  }
  // Commands that change channel policy write this plugin's own settings section
  // rather than any global default, so a chat-side switch stays inside WeCom.
  let writeSettings: ((section: WeComSettingsPatch, botId?: string) => Promise<void>) | undefined
  // Outbound images need the stored bytes; a deployment without the store keeps
  // working and reports the images it could not send.
  let attachments: Context['attachments'] | undefined
  const runtime = new WeComRuntimeController({
    api,
    logger,
    writeSettings: async (section, botId) => {
      if (writeSettings === undefined) throw new Error('this deployment has no writable settings provider')
      await writeSettings(section, botId)
    },
    resolveCredentials: next => resolveCredentials(ctx, next),
    createClient: credentials => new WSClient(credentials),
    prepareContext: async current => ({
      bindings: await bindingStore(),
      defaultWorkspace: await resolveDefaultWorkspace(
        api,
        resolveDshHome(),
        current.workspaceId,
        current.workspaceName ?? DEFAULT_WORKSPACE_NAME,
        settings().bots === undefined || current.id === 'default' ? undefined : current.id,
      ),
      readFile: (ref, signal) => {
        if (attachments === undefined) throw new Error('this deployment has no attachment store')
        return attachments.readFileStream(ref, signal)
      },
      readPresentedFile: (sessionId, path, maxBytes, signal) => readPresentedFile(ctx, sessionId, path, '', maxBytes, signal),
      readImage: async ref => {
        if (attachments === undefined) throw new Error('this deployment has no attachment store')
        return (await attachments.readImage(ref)).data
      },
    }),
  })
  ctx.inject(['attachments'], scope => {
    attachments = scope.attachments
    scope.effect(() => () => { if (attachments === scope.attachments) attachments = undefined },
      'wecom-aibot: attachment store')
  })
  ctx.inject(['approval'], (approvalCtx) => {
    installChannelApproval(approvalCtx,
      sessionId => runtime.ownsSession(sessionId),
      request => runtime.requestApproval(request))
  })
  ctx.on('loader/volatile-update', () => { runtime.update(settings()) })
  ctx.inject(['settings'], settingsCtx => {
    // Path ops rather than a wholesale replace: the caller only names the field it
    // changed and cannot drop settings it never read, which a merge patch also
    // cannot express for the reset-to-inherited case.
    writeSettings = async (section, botId) => {
      const index = botId === undefined ? undefined : settings().bots?.findIndex(bot => bot.id === botId)
      if (botId !== undefined && (index === undefined || index < 0)) throw new Error('Bot was removed')
      const prefix: string[] = index === undefined ? [] : ['bots', String(index)]
      await settingsCtx.settings.mutate(WECOM_AIBOT_SETTINGS_NAMESPACE,
        Object.entries(section).map(([key, value]) => value === undefined
          ? { op: 'unset' as const, path: [...prefix, key] }
          : { op: 'set' as const, path: [...prefix, key], value }))
    }
    settingsCtx.effect(() => () => { writeSettings = undefined })
  })
  runtime.update(settings())
  ctx.effect(
    () => onCredentialsUpdated(ctx, (ref) => {
      const current = settings()
      if (configuredBots(current).some(bot => ref === (bot.botIdEnv ?? DEFAULT_BOT_ID_ENV)
        || ref === (bot.secretEnv ?? DEFAULT_SECRET_ENV))) runtime.update(current)
    }),
    'wecom-aibot credentials',
  )
  ctx.effect(() => async () => {
    await runtime.stop()
    await bindings?.then(store => store.drain())
  }, 'wecom-aibot runtime')
}
