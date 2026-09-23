import assert from 'node:assert/strict'
import { readFile, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

const root = new URL('../', import.meta.url)

test('the locked runtime uses the official release without workspace packages', async () => {
  const manifest = JSON.parse(await readFile(new URL('../../runtime/package.json', root), 'utf8'))
  assert.equal(manifest.dependencies['@deepseek-ai/dsh'], '0.1.6-alpha.2')
  const lock = await readFile(new URL('../../runtime/pnpm-lock.yaml', root), 'utf8')
  assert.doesNotMatch(lock, /(?:specifier|version):\s*['"]?(?:workspace|file|link):/)
})

test('the native launcher compiles against macOS frameworks', { skip: process.platform !== 'darwin' }, () => {
  execFileSync('/usr/bin/xcrun', ['swiftc', '-typecheck', '-framework', 'AppKit', '-framework', 'WebKit',
    ...['Main.swift', 'AppDelegate.swift', 'MainMenu.swift', 'MainWindowController.swift', 'WebDownloads.swift', 'ServerController.swift', 'RuntimePaths.swift', 'HostOutput.swift', 'HostRecovery.swift', 'HostRestartRequest.swift', 'ShareBridge.swift', '../Share/ShareInbox.swift']
      .map(name => fileURLToPath(new URL('Sources/' + name, root)))], { stdio: 'pipe' })
})

test('Host recovery stops startup failures and bounds repeated post-readiness exits', { skip: process.platform !== 'darwin' }, async () => {
  const scratch = await mkdtemp(join(tmpdir(), 'dsh-native-recovery-'))
  try {
    const binary = join(scratch, 'recovery')
    execFileSync('/usr/bin/xcrun', ['swiftc', fileURLToPath(new URL('Sources/HostRecovery.swift', root)),
      fileURLToPath(new URL('tests/recovery/main.swift', root)), '-o', binary])
    assert.equal(execFileSync(binary, { encoding: 'utf8' }).trim(), 'Bounded Host recovery verified')
  } finally { await rm(scratch, { recursive: true, force: true }) }
})

test('native paths default to ~/.dsh and respect the profile pinned in the app', { skip: process.platform !== 'darwin' }, async () => {
  const scratch = await mkdtemp(join(tmpdir(), 'dsh-native-paths-'))
  try {
    const binary = join(scratch, 'paths')
    execFileSync('/usr/bin/xcrun', ['swiftc', fileURLToPath(new URL('Sources/RuntimePaths.swift', root)),
      fileURLToPath(new URL('tests/paths/main.swift', root)), '-o', binary])
    assert.equal(execFileSync(binary, { encoding: 'utf8' }).trim(), 'Shared profile paths verified')
  } finally { await rm(scratch, { recursive: true, force: true }) }
})

test('the window WebView accepts the activating mouse click', { skip: process.platform !== 'darwin' }, async () => {
  const scratch = await mkdtemp(join(tmpdir(), 'dsh-native-first-click-'))
  try {
    const binary = join(scratch, 'first-click')
    execFileSync('/usr/bin/xcrun', ['swiftc', '-parse-as-library', '-framework', 'AppKit', '-framework', 'WebKit',
      fileURLToPath(new URL('Sources/MainWindowController.swift', root)),
      fileURLToPath(new URL('Sources/WebDownloads.swift', root)),
      fileURLToPath(new URL('Sources/ShareBridge.swift', root)),
      fileURLToPath(new URL('Share/ShareInbox.swift', root)),
      fileURLToPath(new URL('tests/first-click/main.swift', root)), '-o', binary])
    assert.equal(execFileSync(binary, { encoding: 'utf8' }).trim(), 'Window WebView accepts the activating click')
  } finally { await rm(scratch, { recursive: true, force: true }) }
})

test('the native bridge accepts only the current installation origin', { skip: process.platform !== 'darwin' }, async () => {
  const scratch = await mkdtemp(join(tmpdir(), 'dsh-native-bridge-'))
  try {
    const binary = join(scratch, 'bridge')
    execFileSync('/usr/bin/xcrun', ['swiftc', '-framework', 'AppKit', '-framework', 'WebKit',
      fileURLToPath(new URL('Sources/MainWindowController.swift', root)),
      fileURLToPath(new URL('Sources/WebDownloads.swift', root)),
      fileURLToPath(new URL('Sources/ShareBridge.swift', root)),
      fileURLToPath(new URL('Share/ShareInbox.swift', root)),
      fileURLToPath(new URL('tests/bridge/main.swift', root)), '-o', binary])
    assert.equal(execFileSync(binary, { encoding: 'utf8' }).trim(), 'Native bridge origin isolation verified')
  } finally { await rm(scratch, { recursive: true, force: true }) }
})

test('downloads isolate origins and publish files without destroying existing data', { skip: process.platform !== 'darwin' }, async () => {
  const scratch = await mkdtemp(join(tmpdir(), 'dsh-native-download-'))
  try {
    const binary = join(scratch, 'downloads')
    execFileSync('/usr/bin/xcrun', ['swiftc', '-framework', 'AppKit', '-framework', 'WebKit',
      fileURLToPath(new URL('Sources/MainWindowController.swift', root)),
      fileURLToPath(new URL('Sources/WebDownloads.swift', root)),
      fileURLToPath(new URL('Sources/ShareBridge.swift', root)),
      fileURLToPath(new URL('Share/ShareInbox.swift', root)),
      fileURLToPath(new URL('tests/downloads/main.swift', root)), '-o', binary])
    assert.equal(execFileSync(binary, { encoding: 'utf8' }).trim(), 'Download isolation and publication verified')
  } finally { await rm(scratch, { recursive: true, force: true }) }
})

test('Quit bypasses the modal responder chain and reaches the owned shutdown handler', { skip: process.platform !== 'darwin' }, async () => {
  const scratch = await mkdtemp(join(tmpdir(), 'dsh-native-menu-'))
  try {
    const binary = join(scratch, 'menu')
    execFileSync('/usr/bin/xcrun', ['swiftc', '-parse-as-library', '-framework', 'AppKit',
      fileURLToPath(new URL('Sources/MainMenu.swift', root)),
      fileURLToPath(new URL('tests/menu/main.swift', root)), '-o', binary])
    assert.equal(execFileSync(binary, { encoding: 'utf8' }).trim(), 'Quit targets the owned download shutdown path')
  } finally { await rm(scratch, { recursive: true, force: true }) }
})

test('reopen preserves the Host and explicit restart targets its installation', { skip: process.platform !== 'darwin' }, async () => {
  const scratch = await mkdtemp(join(tmpdir(), 'dsh-native-lifecycle-'))
  try {
    const binary = join(scratch, 'lifecycle')
    execFileSync('/usr/bin/xcrun', ['swiftc', '-parse-as-library', '-framework', 'AppKit', '-framework', 'WebKit',
      ...['AppDelegate.swift', 'MainMenu.swift', 'MainWindowController.swift', 'WebDownloads.swift', 'ServerController.swift', 'RuntimePaths.swift', 'HostOutput.swift', 'HostRecovery.swift', 'HostRestartRequest.swift', 'ShareBridge.swift', '../Share/ShareInbox.swift']
        .map(name => fileURLToPath(new URL('Sources/' + name, root))),
      fileURLToPath(new URL('tests/lifecycle/main.swift', root)), '-o', binary])
    assert.equal(execFileSync(binary, { encoding: 'utf8' }).trim(), 'Reopen preserves the Host; explicit restart targets its installation')
  } finally { await rm(scratch, { recursive: true, force: true }) }
})

test('startup handshake accepts only this child origin and redacts split tokens', { skip: process.platform !== 'darwin' }, async () => {
  const scratch = await mkdtemp(join(tmpdir(), 'dsh-native-auth-'))
  try {
    const binary = join(scratch, 'handshake')
    execFileSync('/usr/bin/xcrun', ['swiftc', fileURLToPath(new URL('Sources/HostOutput.swift', root)),
      fileURLToPath(new URL('tests/handshake/main.swift', root)), '-o', binary])
    assert.equal(execFileSync(binary, { encoding: 'utf8' }).trim(), 'Startup handshake verified')
  } finally { await rm(scratch, { recursive: true, force: true }) }
})
