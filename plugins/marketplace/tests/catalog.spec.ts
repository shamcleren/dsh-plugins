import { describe, expect, it } from 'vitest'
import { parseMarketplaceCatalog } from '../src/catalog.ts'

function catalog(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    schemaVersion: 1,
    plugins: [{
      id: 'wecom-aibot',
      package: '@shamcleren/dsh-wecom-aibot',
      name: 'WeCom AI Bot',
      description: 'WeCom channel',
      version: '0.3.0',
      dshVersion: '>=0.1.0-rc.8 <0.2.0',
      placement: 'before-web-app',
      artifact: { path: 'artifacts/wecom.tgz', sha256: 'a'.repeat(64), size: 42 },
      ...overrides,
    }],
  })
}

describe('parseMarketplaceCatalog', () => {
  it('validates and derives compatibility and profile placement', () => {
    expect(parseMarketplaceCatalog({
      text: catalog(), repository: 'shamcleren/dsh-plugin', ref: 'main',
      dshVersion: '0.1.0-rc.8', maxArtifactBytes: 1024,
    }))
      .toMatchObject({
        repository: 'shamcleren/dsh-plugin',
        ref: 'main',
        plugins: [{ compatible: true, placement: 'before-web-app' }],
      })
  })

  it('keeps incompatible entries visible without making them installable', () => {
    expect(parseMarketplaceCatalog({
      text: catalog({ dshVersion: '>=0.2.0' }), repository: 'shamcleren/dsh-plugin', ref: 'main',
      dshVersion: '0.1.0-rc.8', maxArtifactBytes: 1024,
    }).plugins[0]?.compatible).toBe(false)
  })

  it.each(['../plugin.tgz', '/plugin.tgz', 'artifacts\\plugin.tgz'])('rejects unsafe artifact path %s', (path) => {
    expect(() => parseMarketplaceCatalog({
      text: catalog({ artifact: { path, sha256: 'a'.repeat(64), size: 42 } }),
      repository: 'shamcleren/dsh-plugin', ref: 'main', dshVersion: '0.1.0-rc.8', maxArtifactBytes: 1024,
    })).toThrow(/unsafe/)
  })

  it('rejects artifacts above the configured byte limit', () => {
    expect(() => parseMarketplaceCatalog({
      text: catalog({ artifact: { path: 'artifacts/plugin.tgz', sha256: 'a'.repeat(64), size: 2048 } }),
      repository: 'shamcleren/dsh-plugin', ref: 'main', dshVersion: '0.1.0-rc.8', maxArtifactBytes: 1024,
    })).toThrow(/size limit/)
  })
})
