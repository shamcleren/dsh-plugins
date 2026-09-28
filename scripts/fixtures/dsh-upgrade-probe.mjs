/** Loaded only by the isolated release smoke; never shipped in a user profile. */
import assert from 'node:assert/strict'
import { readFile, mkdir, copyFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { registerHostRpc } from '../../plugins/security-scan/lib/host-rpc.js'
export const inject = ['settings', 'agentPresets', 'connection', 'webServer', 'trustedMarketplace', 'profileContext']
export function apply(ctx) {
  ctx.on('plugin-manager/install-log', chunk => {
    if (chunk.text) console.log('Isolated package operation: ' + chunk.text.replace(/([?&]token=)[^\s]+/g, '$1[redacted]'))
  })
  registerHostRpc(ctx, '/smoke-upgrade', async method => {
    if (method === 'diagnostic') return { ok: true, value: [...ctx.root.loader.entries()].filter(e => e.fiber && e.fiber.state !== 2).map(e => ({ id: e.options.id, state: e.fiber.state, error: String(e.fiber._error ?? '') })) }
    if (method === 'mutation') {
      const artifact = process.env.DSH_SMOKE_ARTIFACT
      assert.ok(artifact, 'isolated artifact supplied')
      const bytes = await readFile(artifact), sha256 = createHash('sha256').update(bytes).digest('hex')
      const cache = join(ctx.profileContext.home, 'plugin-cache')
      await mkdir(cache, { recursive: true })
      await copyFile(artifact, join(cache, sha256 + '.tgz'))
      const service = ctx.trustedMarketplace, original = service.catalog
      const packageName = '@shamcleren/dsh-wecom-tools'
      // Replace only remote catalog transport; package operations use the actual Host manager.
      service.catalog = async () => ({ repository: 'isolated', ref: 'fixture', plugins: [{
        packageName, compatible: true, placement: 'after-web-app', artifact: { sha256, size: bytes.length },
      }] })
      try {
        await service.deletePackage(packageName)
        assert.ok(!(await service.state()).installed.some(p => p.packageName === packageName))
        await service.add(packageName)
        assert.ok((await service.state()).installed.some(p => p.packageName === packageName))
        await service.add(packageName)
        return { ok: true, value: { profile: ctx.profileContext.name, removed: true, installed: true, updated: true } }
      } finally { service.catalog = original }
    }
    const changes = {
      'security-scan': { semgrepPath: '/nonexistent/upgrade-semgrep', hookTools: ['edit'] },
      'trusted-marketplace': { ref: 'upgrade-fixture' },
      'desktop-pet': { petSize: 128 },
      aidev: { requestTimeoutMs: 31000 },
      wechat: { thinkingText: 'upgrade fixture' },
      'wecom-aibot': { thinkingText: 'upgrade fixture' },
    }
    const initial = ctx.settings.describe()
    assert.equal(initial.find(item => item.ns === 'desktop-pet')?.value.petSize, 120, 'legacy pet settings imported')
    assert.equal(initial.find(item => item.ns === 'security-scan')?.value.gitleaksPath, '/nonexistent/legacy-gitleaks', 'legacy scanner settings imported')
    for (const [ns, patch] of Object.entries(changes)) {
      const before = ctx.settings.describe().find(item => item.ns === ns)
      assert.ok(before, ns + ': live form exists')
      await ctx.settings.update(ns, patch, before.revision)
      const after = ctx.settings.describe().find(item => item.ns === ns)
      for (const [key, value] of Object.entries(patch)) assert.deepEqual(after.value[key], value, ns + ': live field ' + key)
      await assert.rejects(ctx.settings.update(ns, patch, before.revision), /changed|revision|conflict/i)
    }
    await assert.rejects(ctx.settings.update('desktop-pet', { sourceDir: '/tmp/not-owned' }), /live|volatile|editable/i)
    for (const id of ['aidev', 'dsh-security-audit']) {
      const preset = await ctx.agentPresets.resolve(id)
      assert.equal(preset.broken, undefined, id + ': ' + preset.broken)
    }
    return { ok: true, value: { forms: Object.keys(changes).length, presets: 2 } }
  })
}
