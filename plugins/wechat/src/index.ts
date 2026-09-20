import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import type {} from '@deepseek-ai/dsh-attachment'
import type {} from '@deepseek-ai/dsh-settings'
import { installChannelApproval } from './approval.js'
import { installChannelTitle } from './channel-title.js'
import { ConversationBindings } from './bindings.js'
import { Config, DEFAULT_WORKSPACE_NAME } from './config.js'
import type { WeChatSettingsPatch } from './config.js'
import { createHostApi } from './host-api.js'
import { WeChatRuntimeController } from './runtime.js'
import { WeChatAccountStore } from './storage.js'
import { WeChatLoginService } from './login.js'
import { resolveDefaultWorkspace } from './workspace.js'

export { Config, DEFAULT_BASE_URL, DEFAULT_CDN_BASE_URL, DEFAULT_MEDIA_MAX_BYTES,
  DEFAULT_THINKING_TEXT, DEFAULT_TURN_TIMEOUT_MS, DEFAULT_WORKSPACE_NAME } from './config.js'
export type { Config as WeChatConfig } from './config.js'

export const name = 'wechat'
export const inject = ['sessionController', 'workspaceRegistry', 'sessions']
export const WECHAT_SETTINGS_NAMESPACE = 'wechat'

/** Mount the personal WeChat account runtime and its settings namespace. */
export function apply(ctx: Context, config: Config): void {
  const api = createHostApi(ctx, sessionId => runtime?.routesSession(sessionId) === true)
  const logger = ctx.logger(name)
  installChannelTitle(ctx, logger)
  const channelHome = join(resolveDshHome(), 'channels', 'wechat')
  const bindings = ConversationBindings.open(join(channelHome, 'bindings.json'))
  let settings = (): Config => config
  let runtime: WeChatRuntimeController | undefined
  // Commands that change channel policy write this plugin's own settings section
  // rather than any global default, so a chat-side switch stays inside WeChat.
  let writeSettings: ((section: WeChatSettingsPatch) => Promise<void>) | undefined
  // Outbound images need the stored bytes; a deployment without the store keeps
  // working and reports the images it could not send.
  let attachments: Context['attachments'] | undefined
  const ready = WeChatAccountStore.open(channelHome).then(async store => {
    runtime = new WeChatRuntimeController({
      api,
      logger,
      store,
      writeSettings: async section => {
        if (writeSettings === undefined) throw new Error('this deployment has no writable settings provider')
        await writeSettings(section)
      },
      prepareContext: async current => ({
        bindings: await bindings,
        defaultWorkspace: await resolveDefaultWorkspace(
          api,
          resolveDshHome(),
          current.workspaceId,
          current.workspaceName ?? DEFAULT_WORKSPACE_NAME,
        ),
        readImage: async ref => {
          if (attachments === undefined) throw new Error('this deployment has no attachment store')
          return (await attachments.readImage(ref)).data
        },
      }),
    })
    new WeChatLoginService(ctx, store, logger, async () => {
      runtime!.update(settings())
      await runtime!.ready()
    }, () => runtime!.state())
    runtime.update(settings())
    return { runtime, store }
  })
  ctx.inject(['attachments'], scope => {
    attachments = scope.attachments
    scope.effect(() => () => { if (attachments === scope.attachments) attachments = undefined },
      'wechat: attachment store')
  })
  ctx.inject(['approval'], approvalCtx => {
    installChannelApproval(approvalCtx,
      sessionId => runtime?.ownsSession(sessionId) === true,
      request => runtime?.requestApproval(request) ?? Promise.resolve(undefined))
  })
  ctx.inject(['settings'], settingsCtx => {
    settingsCtx.settings.installSection(settingsCtx, WECHAT_SETTINGS_NAMESPACE, Config, config, {
    setSource: current => { settings = current },
    onChange: () => { runtime?.update(settings()) },
    })
    // Path ops rather than a wholesale replace: the caller only names the field it
    // changed and cannot drop settings it never read, which a merge patch also
    // cannot express for the reset-to-inherited case.
    writeSettings = async section => {
      await settingsCtx.settings.mutate(WECHAT_SETTINGS_NAMESPACE,
        Object.entries(section).map(([key, value]) => value === undefined
          ? { op: 'unset' as const, path: [key] }
          : { op: 'set' as const, path: [key], value }))
    }
    settingsCtx.effect(() => () => { writeSettings = undefined })
  })
  ctx.effect(() => async () => {
    const active = await ready
    await active.runtime.stop()
    await Promise.all([active.store.drain(), bindings.then(store => store.drain())])
  }, 'wechat runtime')
}
