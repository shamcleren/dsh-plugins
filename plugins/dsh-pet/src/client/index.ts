/** Browser half of the desktop-pet plugin: contributes its own settings card
 * and polls the host's pending-activation route to open the chat window a
 * pet task click requested. */

import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type {} from '@deepseek-ai/dsh-client-ui-plugin-manager/client'
import type {} from '@deepseek-ai/dsh-client-ui-workspace/client'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { PetSettings } from '../config.js'
import { PET_ACTIVATE_PATH } from '../shared/picker.js'
import { DesktopPetCard } from './Card.js'
import { DesktopPetCardController } from './controller.js'
import { en, zh, type LocaleKey } from './locales.js'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Copy owned by the external desktop-pet settings card. */
    'settings.desktop-pet': LocaleKey
  }
}

const LOCALE_NAMESPACE = 'settings.desktop-pet'
const SETTINGS_NAMESPACE = 'desktop-pet'
const ACTIVATE_POLL_MS = 500

export const inject = ['slots', 'locale', 'settingsScope', 'uiWorkspace']

/**
 * Poll the host for a pending session activation (a task-list row the user
 * clicked in the native pet window) and navigate to its chat window. Runs for
 * the plugin's lifetime; the returned disposer stops the poll loop.
 */
function startActivatePoll(ctx: ClientContext): () => void {
  let disposed = false
  let timer: ReturnType<typeof setTimeout> | undefined

  const tick = async (): Promise<void> => {
    if (disposed) return
    try {
      const response = await fetch(PET_ACTIVATE_PATH)
      if (response.status === 200) {
        const body = (await response.json()) as { sessionId?: unknown }
        if (typeof body.sessionId === 'string' && body.sessionId !== '') {
          ctx.uiWorkspace.openSession(body.sessionId as SessionId)
        }
      }
    } catch {
      // Network/timing errors are benign; retry on the next tick.
    }
    if (!disposed) {
      timer = setTimeout(() => void tick(), ACTIVATE_POLL_MS)
    }
  }

  void tick()
  return () => {
    disposed = true
    if (timer !== undefined) clearTimeout(timer)
  }
}

/** Register the desktop-pet card in the generic plugin-settings slot. */
export function apply(ctx: ClientContext): void {
  const scope = ctx.settingsScope.bind<PetSettings>({ namespace: SETTINGS_NAMESPACE })
  const card = new DesktopPetCardController(scope)
  ctx.effect(
    () => () => card.dispose(),
    'desktop-pet: browser controller',
  )
  ctx.effect(
    () => ctx.locale.register(LOCALE_NAMESPACE, { zh, en }),
    'desktop-pet: browser dictionaries',
  )
  ctx.effect(
    () => startActivatePoll(ctx),
    'desktop-pet: browser activation poll',
  )
  ctx.slots.inject('plugins.bundle.config', () => ctx.slots.register({
    name: 'plugins.bundle.config',
    key: '@shamcleren/dsh-pet',
    locale: LOCALE_NAMESPACE,
    inject: () => card.inject(),
  }, DesktopPetCard))
}
