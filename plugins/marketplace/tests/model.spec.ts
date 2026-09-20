import { describe, expect, it } from 'vitest'
import { pluginRows, visibleRows } from '../src/client/model.ts'
import type { MarketplacePlugin } from '../src/client/types.ts'

const plugin = (name: string, version: string, compatible = true): MarketplacePlugin => ({
  id: name,
  packageName: `@example/${name}`,
  name,
  description: `${name} description`,
  version,
  dshVersion: '>=0.1.0-rc.8',
  placement: 'after-web-app',
  artifact: { path: `${name}.tgz`, sha256: '0'.repeat(64), size: 1 },
  compatible,
})

describe('Marketplace view model', () => {
  it('never labels a newer local release or the same version as a remote update', () => {
    const rows = pluginRows([plugin('newer', '0.2.2'), plugin('same', '1.0.0'), plugin('pre', '1.0.0')], [
      { packageName: '@example/newer', specifier: 'file:local.tgz', version: '0.3.0' },
      { packageName: '@example/same', specifier: '1.0.0', version: '1.0.0' },
      { packageName: '@example/pre', specifier: '1.0.0-rc.1', version: '1.0.0-rc.1' },
    ])
    expect(rows.map(row => row.updateAvailable)).toEqual([false, false, true])
  })
  it('joins installed versions and marks only compatible version changes as updates', () => {
    const rows = pluginRows([plugin('alpha', '2.0.0'), plugin('beta', '2.0.0', false)], [
      { packageName: '@example/alpha', specifier: '1.0.0', version: '1.0.0' },
      { packageName: '@example/beta', specifier: '1.0.0', version: '1.0.0' },
    ])
    expect(rows.map(row => row.updateAvailable)).toEqual([true, false])
  })

  it('combines text search with the selected catalog filter', () => {
    const rows = pluginRows([plugin('alpha', '2.0.0'), plugin('beta', '1.0.0')], [
      { packageName: '@example/alpha', specifier: '1.0.0', version: '1.0.0' },
    ])
    expect(visibleRows(rows, 'ALPHA', 'updates').map(row => row.plugin.name)).toEqual(['alpha'])
    expect(visibleRows(rows, 'beta', 'updates')).toEqual([])
  })
})
