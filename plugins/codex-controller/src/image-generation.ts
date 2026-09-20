/** Safe projection of a completed Codex image-generation item. */
import { basename } from 'node:path'

const MAX_ENCODED_IMAGE_CHARS = 48 * 1024 * 1024

export interface GeneratedImage {
  id: string
  bytes: Uint8Array
  name: string
}

export function generatedImage(params: Record<string, unknown>): GeneratedImage | undefined {
  const item = asRecord(params.item)
  if (!item || item.type !== 'imageGeneration' || item.status !== 'completed') return
  const id = nonEmptyString(item.id)
  const result = nonEmptyString(item.result)
  if (!id || !result || result.length > MAX_ENCODED_IMAGE_CHARS) return
  const encoded = result.startsWith('data:image/png;base64,') ? result.slice('data:image/png;base64,'.length) : result
  if (!canonicalBase64(encoded)) return
  const bytes = Buffer.from(encoded, 'base64')
  if (!bytes.length || !png(bytes)) return
  const savedPath = nonEmptyString(item.savedPath)
  const leaf = savedPath ? basename(savedPath) : ''
  return { id, bytes, name: safeName(leaf) || 'codex-generated.png' }
}

function canonicalBase64(value: string): boolean {
  return value.length > 0 && value.length % 4 === 0 && /^[A-Za-z0-9+/]*={0,2}$/.test(value)
}

function png(value: Uint8Array): boolean {
  return value.length >= 8
    && value[0] === 0x89
    && value[1] === 0x50
    && value[2] === 0x4e
    && value[3] === 0x47
    && value[4] === 0x0d
    && value[5] === 0x0a
    && value[6] === 0x1a
    && value[7] === 0x0a
}

function safeName(value: string): string {
  const cleaned = value.replace(/[\u0000-\u001f\u007f]/g, '').trim()
  return cleaned && cleaned.toLowerCase().endsWith('.png') ? cleaned.slice(0, 200) : ''
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value ? value : undefined
}
