import { cp, mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'

/** macOS team-prefixed App Groups do not require a provisioning profile. */
export function shareBuildOptions(bundleIdentifier, env = process.env) {
  const team = env.DSH_SHARE_TEAM_ID
  if (team === undefined) return undefined
  if (!/^[A-Z0-9]{10}$/.test(team) || !env.CODESIGN_IDENTITY || env.CODESIGN_IDENTITY === '-') throw new Error('DSH_SHARE_TEAM_ID requires a 10-character team ID and CODESIGN_IDENTITY')
  return { team, group: team + '.' + bundleIdentifier + '.share', identity: env.CODESIGN_IDENTITY }
}

export async function buildShareExtension({ root, contents, bundleIdentifier, version, target, options, run }) {
  const extension = join(contents, 'PlugIns/DSHShare.appex')
  await mkdir(join(extension, 'Contents/MacOS'), { recursive: true })
  const resources = join(extension, 'Contents/Resources')
  await cp(join(root, 'Resources/ShareLocalizations'), resources, { recursive: true })
  const plist = (await readFile(join(root, 'Resources/Share-Info.plist'), 'utf8'))
    .replaceAll('__BUNDLE_IDENTIFIER__', bundleIdentifier).replaceAll('__APP_VERSION__', version).replaceAll('__SHARE_GROUP__', options.group)
  await writeFile(join(extension, 'Contents/Info.plist'), plist)
  await run('/usr/bin/xcrun', ['swiftc', '-target', target, '-O', '-framework', 'AppKit', '-Xlinker', '-e', '-Xlinker', '_NSExtensionMain',
    ...['ShareInbox.swift', 'ShareViewController.swift', 'main.swift'].map(name => join(root, 'Share', name)), '-o', join(extension, 'Contents/MacOS/DSHShare')])
  const entitlements = sandbox => `<?xml version="1.0" encoding="UTF-8"?><plist version="1.0"><dict>${sandbox ? '<key>com.apple.security.app-sandbox</key><true/>' : ''}<key>com.apple.security.application-groups</key><array><string>${options.group}</string></array></dict></plist>`
  const extensionEntitlements = join(contents, 'Resources/share.entitlements')
  const appEntitlements = join(contents, 'Resources/app.entitlements')
  await writeFile(extensionEntitlements, entitlements(true))
  await writeFile(appEntitlements, entitlements(false))
  await run('/usr/bin/codesign', ['--force', '--sign', options.identity, '--timestamp=none', '--entitlements', extensionEntitlements, extension])
  const signature = spawnSync('/usr/bin/codesign', ['-d', '--verbose=4', extension], { encoding: 'utf8' })
  if (signature.status !== 0 || !signature.stderr.split('\n').includes('TeamIdentifier=' + options.team)) throw new Error('Share extension signing identity does not match DSH_SHARE_TEAM_ID')
  await run('/usr/bin/codesign', ['--verify', '--strict', extension])
  return appEntitlements
}
