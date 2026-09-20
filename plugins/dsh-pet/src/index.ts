/**
 * desktop-pet — a desktop floating pet for DeepSeek Harness, reusing the
 * Codex/OpenAI pet asset packs. Host-only: reduces session events into a pet
 * state and drives a bundled native Helper (transparent always-on-top window)
 * over a stdio JSON protocol. No DSH app-shell changes are required.
 */

import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Context } from '@deepseek-ai/cordis'
import type { SettingsProvider } from '@deepseek-ai/dsh-settings'
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'
import type {} from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-user-questions'
import type {} from '@deepseek-ai/dsh-user-approval'
import { Config, PetSettings } from './config.js'
import { HelperProcess } from './helper-process.js'
import { resolveSelection, retireBundledAlias, syncPacks, type PetPack } from './packs.js'
import { MessageKind, type CompanionMessage } from './protocol.js'
import { registerPetRoutes } from './server.js'
import { canonicalPetId, PET_ID_ALIASES, RETIRED_PET_IDS } from './shared/picker.js'
import { PanelStateStore, type Position } from './state-store.js'
import { PetStatusTracker } from './status.js'

export { Config } from './config.js'
export type { Config as DesktopPetConfig } from './config.js'
export { PetSettings } from './config.js'
export { MessageKind } from './protocol.js'
export { HelperProcess } from './helper-process.js'
export { PetStatusTracker } from './status.js'

export const name = 'desktop-pet'

const here = dirname(fileURLToPath(import.meta.url))
const HELPER_BINARY = join(here, 'helper', 'darwin', 'desktop-pet-helper.app', 'Contents', 'MacOS', 'desktop-pet-helper')
const BUNDLED_PETS_DIR = join(here, '..', 'assets', 'pets')
const HELPER_RESTART_DELAY_MS = 2000

/** Validate the Helper's `move` payload as a finite screen position. */
function parsePosition(value: unknown): Position | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
  const record = value as Record<string, unknown>
  if (typeof record.x !== 'number' || typeof record.y !== 'number') return null
  if (!Number.isFinite(record.x) || !Number.isFinite(record.y)) return null
  return { x: record.x, y: record.y }
}

export function apply(ctx: Context, config: Config): void {
  const logger = ctx.logger(name)

  const packsDir = dshHomePath('desktop-pet', 'packs')
  const stateStore = new PanelStateStore(dshHomePath('desktop-pet', 'state.json'))

  // The runtime-adjustable subset, authoritative once the settings provider
  // attaches; falls back to the composition entry otherwise.
  const entry: PetSettings = {
    enabled: config.enabled,
    petId: config.petId,
    petSize: config.petSize,
  }
  let fallback: PetSettings = { ...entry }
  let source: () => PetSettings = () => fallback
  let settingsProvider: SettingsProvider | undefined

  let packs: PetPack[] = []
  let helper: HelperProcess | undefined
  let restartTimer: NodeJS.Timeout | undefined
  let disposed = false
  let ready: Promise<void> | undefined
  // Helper messages are ordered protocol events. In particular, shutdown
  // sends MOVE then CLOSED; serial processing makes the position write a
  // durable happens-before boundary for plugin disposal.
  let messageQueue: Promise<void> = Promise.resolve()
  /** Session id the browser card should open next; consumed by the activate route. */
  let pendingActivation: string | null = null

  const tracker = new PetStatusTracker(ctx)

  const buildConfigPayload = async () => {
    const state = await stateStore.load()
    const s = source()
    const selected = resolveSelection(packs, canonicalPetId(s.petId))
    return {
      // The machine may have multiple Harness variants running. Passing the
      // actual parent PID lets the native pet focus this exact host instance.
      hostPid: process.ppid,
      packsDir,
      pets: packs.map(pack => ({
        id: pack.id,
        displayName: pack.displayName,
        version: pack.spriteVersionNumber ?? 1,
        spritesheetPath: pack.spritesheetPath,
      })),
      petId: selected?.id ?? s.petId,
      petSize: s.petSize,
      quadrant: config.startQuadrant,
      position: state.position,
      positionMode: state.positionMode,
    }
  }

  const pushConfig = async (): Promise<void> => {
    if (helper === undefined) return
    helper.send('config', await buildConfigPayload())
  }

  const pushDisplay = (): void => {
    if (helper === undefined) return
    const display = tracker.currentDisplay()
    helper.send('state', { state: display.state, bubble: display.bubble, tasks: display.tasks })
  }

  const applySettings = async (): Promise<void> => {
    if (disposed) return
    const s = source()
    if (s.enabled) {
      if (ready !== undefined) await ready
      if (disposed || !source().enabled) return
      startHelper()
      await pushConfig()
    } else {
      const currentHelper = helper
      helper = undefined
      if (currentHelper !== undefined) await currentHelper.stop()
    }
  }

  // Runtime writes flow through the settings provider when available so the
  // Web Settings card, the Helper context menu, and persistence all agree.
  const writeSetting = async (patch: Partial<PetSettings>): Promise<void> => {
    if (settingsProvider !== undefined) {
      await settingsProvider.update('desktop-pet', patch)
      return
    }
    fallback = { ...fallback, ...patch }
    await applySettings()
  }

  const processMessage = async (message: CompanionMessage): Promise<void> => {
    switch (message.kind) {
      case MessageKind.READY:
        await pushConfig()
        pushDisplay()
        break
      case MessageKind.SELECT:
        if (typeof message.petId === 'string') {
          if (resolveSelection(packs, message.petId) === undefined) {
            logger.warn(`desktop-pet: unknown pet id "${message.petId}"`)
          }
          await writeSetting({ petId: message.petId })
        }
        break
      case MessageKind.RESIZE:
        if (typeof message.petSize === 'number') {
          await writeSetting({ petSize: message.petSize })
        }
        break
      case MessageKind.HIDE:
        await writeSetting({ enabled: false })
        break
      case MessageKind.MOVE: {
        const position = parsePosition(message.position)
        if (position !== null) {
          const positionMode = message.positionMode === 'pet-anchor' ? 'pet-anchor' : 'panel-origin'
          await stateStore.update({ position, positionMode })
        }
        break
      }
      case MessageKind.ACTIVATE:
        if (typeof message.sessionId === 'string' && message.sessionId !== '') {
          pendingActivation = message.sessionId
          tracker.acknowledge(message.sessionId)
        }
        break
      case MessageKind.CLOSED:
        break
      default:
        break
    }
  }

  const handleMessage = (message: CompanionMessage): void => {
    messageQueue = messageQueue.then(() => processMessage(message)).catch(error => {
      logger.warn(`desktop-pet: failed to process helper message: ${error instanceof Error ? error.message : String(error)}`)
    })
  }

  const startHelper = (): void => {
    if (disposed || helper !== undefined) return
    if (!existsSync(HELPER_BINARY)) {
      logger.warn(`desktop-pet: helper binary not found at ${HELPER_BINARY}`)
      return
    }
    helper = new HelperProcess({
      binaryPath: HELPER_BINARY,
      onMessage: handleMessage,
      onError: error => logger.warn(`desktop-pet: helper error: ${error.message}`),
      onExit: () => {
        helper = undefined
        if (!disposed) {
          restartTimer = setTimeout(startHelper, HELPER_RESTART_DELAY_MS)
          restartTimer.unref()
        }
      },
      onStderr: line => logger.warn(`desktop-pet[helper]: ${line}`),
    })
    helper.start()
  }

  // Install package-owned defaults first, then import any optional local
  // Codex-compatible packs. Existing target packs are preserved by id.
  ready = (async () => {
    await Promise.all(Object.entries(PET_ID_ALIASES).map(([legacyId, replacementId]) => (
      retireBundledAlias(packsDir, legacyId, join(BUNDLED_PETS_DIR, replacementId))
    )))
    const bundled = await syncPacks(BUNDLED_PETS_DIR, packsDir)
    const imported = await syncPacks(config.sourceDir, packsDir, {
      missingSourceIsError: false,
      excludedIds: RETIRED_PET_IDS,
    })
    packs = imported.packs
    if (packs.length === 0) logger.warn('desktop-pet: no valid pet packs found')
    for (const error of bundled.errors) logger.warn(`desktop-pet[bundled]: ${error}`)
    for (const error of imported.errors) logger.warn(`desktop-pet[import]: ${error}`)
    if (source().enabled) startHelper()
  })()

  tracker.start(() => pushDisplay())

  ctx.inject(['settings'], settingsCtx => {
    settingsProvider = settingsCtx.settings
    settingsCtx.settings.installSection(ctx, 'desktop-pet', PetSettings, entry, {
      setSource: current => {
        source = current
      },
      onChange: () => {
        void applySettings()
      },
    })
  })

  // Expose the scanned packs and their spritesheets to the browser card, which
  // renders the thumbnail picker from this route, plus the pending-activation
  // route the card polls to open the chat window a task click requested.
  ctx.inject(['webServer'], webCtx => {
    registerPetRoutes(webCtx, packsDir, () => packs, {
      consumeActivation: () => {
        const id = pendingActivation
        pendingActivation = null
        return id
      },
    })
  })

  ctx.effect(() => async () => {
    disposed = true
    if (restartTimer !== undefined) clearTimeout(restartTimer)
    restartTimer = undefined
    tracker.dispose()
    const currentHelper = helper
    helper = undefined
    if (ready !== undefined) await ready
    if (currentHelper !== undefined) await currentHelper.stop()
    await messageQueue
  }, 'desktop-pet runtime')
}
