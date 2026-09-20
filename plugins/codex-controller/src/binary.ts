/** Package-local Codex wrapper, independent of the host PATH. */
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'

const require = createRequire(import.meta.url)
const manifestPath = require.resolve('@openai/codex/package.json')
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as { bin?: { codex?: string } }
const bin = manifest.bin?.codex
if (!bin) throw new Error('codex-controller: pinned Codex package has no wrapper')

export const CODEX_BIN = resolve(dirname(manifestPath), bin)

export function codexArgv(): string[] {
  return [process.execPath, CODEX_BIN, 'app-server', '--stdio']
}
