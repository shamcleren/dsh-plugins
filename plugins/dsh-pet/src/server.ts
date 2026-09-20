/**
 * Host HTTP routes that expose the scanned pet packs and their spritesheets to
 * the browser settings card. The card renders one clickable thumbnail per pack
 * by pointing each spritesheet at its first cell, mirroring the Codex pet
 * picker instead of asking the user to type an opaque pet id.
 *
 * Both routes are loopback-only (the host WebServer binds 127.0.0.1), read-only,
 * and serve the user's own already-copied assets, so they are treated like the
 * shell's public non-index static assets rather than authenticated index
 * responses.
 */

import { readFile } from 'node:fs/promises'
import { resolve, sep } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type { PetPack } from './packs.js'
import { ATLAS_V1 } from './shared/atlas.js'
import { PET_ACTIVATE_PATH, PET_PACKS_PATH, PET_SPRITE_PATH, type PetPickerItem } from './shared/picker.js'

/** Cell size is identical across atlas versions (192×208). */
const CELL_WIDTH = ATLAS_V1.cellWidth
const CELL_HEIGHT = ATLAS_V1.cellHeight

/** Project one scanned pack into the JSON row the browser picker consumes. */
export function petListItem(pack: PetPack): PetPickerItem {
  return {
    id: pack.id,
    displayName: pack.displayName,
    version: pack.spriteVersionNumber ?? 1,
    spriteUrl: `${PET_SPRITE_PATH}/${encodeURIComponent(pack.id)}`,
    spriteWidth: pack.spriteWidth,
    spriteHeight: pack.spriteHeight,
    cellWidth: CELL_WIDTH,
    cellHeight: CELL_HEIGHT,
  }
}

/**
 * Resolve a sprite request pathname to a known pack id, or null. The id must
 * be a single path segment that names a scanned pack — this rejects traversal
 * segments and unknown ids before any file is read.
 */
export function resolveSpritePetId(pathname: string, packs: PetPack[]): string | null {
  const prefix = `${PET_SPRITE_PATH}/`
  if (!pathname.startsWith(prefix)) return null
  const raw = pathname.slice(prefix.length)
  if (raw === '' || raw.includes('/') || raw.includes('\\')) return null
  let id: string
  try {
    id = decodeURIComponent(raw)
  } catch {
    return null
  }
  if (id === '') return null
  return packs.some(pack => pack.id === id) ? id : null
}

function writeText(res: import('node:http').ServerResponse, status: number, body: string, contentType: string): void {
  res.writeHead(status, { 'Content-Type': contentType, 'Cache-Control': 'no-store' })
  res.end(body)
}

async function handlePacks(req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse, getPacks: () => PetPack[]): Promise<void> {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    writeText(res, 405, 'method not allowed\n', 'text/plain; charset=utf-8')
    return
  }
  writeText(res, 200, JSON.stringify(getPacks().map(petListItem)), 'application/json; charset=utf-8')
}

async function handleActivate(req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse, consume: () => string | null): Promise<void> {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    writeText(res, 405, 'method not allowed\n', 'text/plain; charset=utf-8')
    return
  }
  const sessionId = consume()
  if (sessionId === null) {
    res.writeHead(204, { 'Cache-Control': 'no-store' })
    res.end()
    return
  }
  writeText(res, 200, JSON.stringify({ sessionId }), 'application/json; charset=utf-8')
}

async function handleSprite(req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse, packsDir: string, getPacks: () => PetPack[]): Promise<void> {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    writeText(res, 405, 'method not allowed\n', 'text/plain; charset=utf-8')
    return
  }
  const pathname = new URL(req.url ?? '/', 'http://localhost').pathname
  const id = resolveSpritePetId(pathname, getPacks())
  if (id === null) {
    writeText(res, 404, 'not found\n', 'text/plain; charset=utf-8')
    return
  }
  const pack = getPacks().find(candidate => candidate.id === id)
  if (pack === undefined) {
    writeText(res, 404, 'not found\n', 'text/plain; charset=utf-8')
    return
  }
  const file = resolve(packsDir, id, pack.spritesheetPath)
  if (!file.startsWith(packsDir + sep)) {
    writeText(res, 403, 'forbidden\n', 'text/plain; charset=utf-8')
    return
  }
  let bytes: Buffer
  try {
    bytes = await readFile(file)
  } catch {
    writeText(res, 404, 'not found\n', 'text/plain; charset=utf-8')
    return
  }
  res.writeHead(200, { 'Content-Type': 'image/webp', 'Cache-Control': 'no-store' })
  res.end(req.method === 'HEAD' ? undefined : bytes)
}

/**
 * Register the picker JSON route, the spritesheet route, and the pending-
 * activation route on the host WebServer. Each registration is owned by the
 * provided context so disposal withdraws all routes together.
 */
export function registerPetRoutes(
  ctx: Context,
  packsDir: string,
  getPacks: () => PetPack[],
  activation: { consumeActivation: () => string | null },
): void {
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: PET_PACKS_PATH,
    handler: (req, res) => handlePacks(req, res, getPacks),
  }), 'desktop-pet: packs route')
  ctx.effect(() => ctx.webServer.register({
    kind: 'prefix',
    path: PET_SPRITE_PATH,
    handler: (req, res) => handleSprite(req, res, packsDir, getPacks),
  }), 'desktop-pet: sprite route')
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: PET_ACTIVATE_PATH,
    handler: (req, res) => handleActivate(req, res, activation.consumeActivation),
  }), 'desktop-pet: activate route')
}
