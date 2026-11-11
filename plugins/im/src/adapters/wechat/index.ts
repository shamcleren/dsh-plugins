import type {} from '@deepseek-ai/cordis-plugin-loader'
import type {} from '../../hub.js'
import type { Config as PlainConfig } from './config.js'
import { join } from 'node:path'
import { type Volatile, type Context } from '@deepseek-ai/cordis'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import type {} from '@deepseek-ai/dsh-attachment'
import type {} from '@deepseek-ai/dsh-settings'
import type {} from '@deepseek-ai/dsh-api-workspace-files'
import { readPresentedFile } from './files.js'
import { installChannelApproval } from './approval.js'
import { installChannelTitle } from './channel-title.js'
import { ConversationBindings } from './bindings.js'
import { Config as ConfigSchema, DEFAULT_WORKSPACE_NAME } from './config.js'
import type { WeChatSettingsPatch } from './config.js'
import { createHostApi } from './host-api.js'
import { WeChatRuntimeController } from './runtime.js'
import { WeChatAccountStore } from './storage.js'
import { WeChatLoginService } from './login.js'
import { resolveDefaultWorkspace } from './workspace.js'
import { WeChatDelivery } from './delivery.js'
import { installPushTools, WeChatPushService } from './push.js'

export const Config = ConfigSchema.volatile()
export { DEFAULT_BASE_URL, DEFAULT_CDN_BASE_URL, DEFAULT_MEDIA_MAX_BYTES,
  DEFAULT_THINKING_TEXT, DEFAULT_TURN_TIMEOUT_MS, DEFAULT_WORKSPACE_NAME } from './config.js'
export type { Config as WeChatConfig } from './config.js'

export const name = 'wechat'
export const inject = ['sessionController', 'workspaceRegistry', 'sessions']
export const WECHAT_SETTINGS_NAMESPACE = 'wechat'

/** Mount the personal WeChat account runtime and its settings namespace. */
export function apply(ctx: Context, config: PlainConfig | Volatile<PlainConfig>): void {
  const api = createHostApi(ctx, sessionId => runtime?.routesSession(sessionId) === true)
  const logger = ctx.logger(name)
  installChannelTitle(ctx, logger)
  const channelHome = join(resolveDshHome(), 'channels', 'wechat')
  const bindings = ConversationBindings.open(join(channelHome, 'bindings.json'))
  const settings = (): PlainConfig => ('get' in config) ? ConfigSchema(config.get()) : config
  let runtime: WeChatRuntimeController | undefined
  // Commands that change channel policy write this plugin's own settings section
  // rather than any global default, so a chat-side switch stays inside WeChat.
  let writeSettings: ((section: WeChatSettingsPatch) => Promise<void>) | undefined
  // Attachment bytes remain provider-owned; unavailable readers produce a delivery notice.
  let attachments: Context['attachments'] | undefined
  const ready = WeChatAccountStore.open(channelHome).then(async store => {
    const delivery = await WeChatDelivery.open(channelHome, store, await bindings,
      () => runtime?.accountIds() ?? [], () => logger.error('wechat: notification outbox unavailable; delivery paused'))
    runtime = new WeChatRuntimeController({
      api,
      logger,
      store,
      delivery,
      reportFailure: kind => ctx.get('imHub')?.report('wechat', kind),
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
        readFile: (ref, signal) => {
          if (attachments === undefined) throw new Error('this deployment has no attachment store')
          return attachments.readFileStream(ref, signal)
        },
        readPresentedFile: async (sessionId, path, maxBytes, signal) => {
          if (ctx.get('workspaceFiles') === undefined) throw new Error('this deployment has no workspace file reader')
          return readPresentedFile(ctx, sessionId, path, '', maxBytes, signal)
        },
        readImage: async ref => {
          if (attachments === undefined) throw new Error('this deployment has no attachment store')
          return (await attachments.readImage(ref)).data
        },
      }),
    })
    new WeChatPushService(ctx, delivery)
    installPushTools(ctx, delivery)
    new WeChatLoginService(ctx, store, logger, async () => {
      runtime!.update(settings())
      await runtime!.ready()
    }, () => runtime!.state())
    runtime.update(settings())
    return { runtime, store, delivery }
  })
  void ready.catch(() => { logger.error('wechat: runtime initialization failed; channel state was preserved') })
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
  ctx.inject(['imHub'], scope => {
    scope.effect(() => scope.imHub.register({ id: 'wechat',
      capabilities: ['text', 'image', 'file', 'video', 'approval', 'questions', 'notifications'],
      state: () => ({ ...(runtime?.state() ?? { status: 'starting', accounts: 0 }),
        enabled: settings().connectionEnabled !== false, ...(settings().connectionEnabled === false ? { status: 'disabled' as const } : {}) }),
    }), 'WeChat IM adapter')
  })
  ctx.on('loader/volatile-update', () => { runtime?.update(settings()) })
  ctx.inject(['settings'], settingsCtx => {
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
    const deliveryStop = active.delivery.stop()
    await active.runtime.stop()
    await deliveryStop
    await Promise.all([active.store.drain(), bindings.then(store => store.drain())])
  }, 'wechat runtime')
}
