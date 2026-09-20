import { createHash } from 'node:crypto'

/** Separate managed installations also need separate macOS preferences and WebKit storage. */
export function buildOptions(installationRoot, environment = process.env) {
  const value = environment.DSH_APP_PORT ?? '3080'
  if (!/^[1-9]\d{0,4}$/.test(value) || Number(value) > 65535) {
    throw new Error('DSH_APP_PORT must be an integer between 1 and 65535')
  }
  return {
    servicePort: Number(value),
    bundleIdentifier: installationRoot === undefined ? 'com.shamcleren.dsh'
      : 'com.shamcleren.dsh.install-' + createHash('sha256').update(installationRoot).digest('hex').slice(0, 16),
  }
}

/** Standalone apps resolve the launching user's home rather than the builder's. */
export function dshHomePlistEntry(dshHome) {
  if (dshHome === undefined) return ''
  const xml = dshHome.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&apos;')
  return '<key>DSHHome</key><string>' + xml + '</string>'
}
