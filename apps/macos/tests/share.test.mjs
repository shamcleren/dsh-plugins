import assert from 'node:assert/strict'
import test from 'node:test'
import { execFileSync } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { shareBuildOptions } from '../share-build.mjs'

test('share signing is explicit, team scoped and isolated per installation', () => {
  assert.equal(shareBuildOptions('com.example.a', {}), undefined)
  assert.throws(() => shareBuildOptions('com.example.a', { DSH_SHARE_TEAM_ID: 'ABCDEFGHIJ' }))
  assert.throws(() => shareBuildOptions('com.example.a', { DSH_SHARE_TEAM_ID: '../bad', CODESIGN_IDENTITY: 'certificate' }))
  const env = { DSH_SHARE_TEAM_ID: 'ABCDEFGHIJ', CODESIGN_IDENTITY: 'certificate' }
  assert.notEqual(shareBuildOptions('com.example.a', env).group, shareBuildOptions('com.example.b', env).group)
})

test('native share inbox rejects unsafe input and survives provider file deletion', { skip: process.platform !== 'darwin' }, async () => {
  const scratch = await mkdtemp(join(tmpdir(), 'dsh-share-check-'))
  try {
    const binary = join(scratch, 'share')
    execFileSync('xcrun', ['swiftc', fileURLToPath(new URL('../Share/ShareInbox.swift', import.meta.url)), fileURLToPath(new URL('share/main.swift', import.meta.url)), '-o', binary])
    assert.match(execFileSync(binary, { encoding: 'utf8' }), /preserves bytes/)
    execFileSync('xcrun', ['swiftc', '-typecheck', fileURLToPath(new URL('../Share/ShareInbox.swift', import.meta.url)), fileURLToPath(new URL('../Share/ShareViewController.swift', import.meta.url))])
  } finally { await rm(scratch, { recursive: true, force: true }) }
})

test('the real system item provider transfers the original filename and bytes', { skip: process.platform !== 'darwin' }, async () => {
  const scratch = await mkdtemp(join(tmpdir(), 'dsh-share-provider-'))
  try {
    const binary = join(scratch, 'provider')
    execFileSync('xcrun', ['swiftc', '-parse-as-library', fileURLToPath(new URL('../Share/ShareInbox.swift', import.meta.url)), fileURLToPath(new URL('../Share/ShareViewController.swift', import.meta.url)), fileURLToPath(new URL('share-provider/main.swift', import.meta.url)), '-o', binary])
    assert.match(execFileSync(binary, { encoding: 'utf8', timeout: 15000 }), /preserves original filenames/)
  } finally { await rm(scratch, { recursive: true, force: true }) }
})
