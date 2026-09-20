import { mkdtemp, readFile, mkdir, writeFile, rm, symlink } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, expect, it } from 'vitest'
import { ensureSecurityPreset, SECURITY_PRESET } from '../src/preset-install.js'
const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })
async function fixture() { const root = await mkdtemp(join(tmpdir(), 'security-preset-')); roots.push(root); return root }
it('installs and reuses its preset without touching other modes or selecting a default', async () => {
  const root = await fixture(), user = join(root, 'presets'), configured = [{ path: user, trust: 'user' as const }]
  await Promise.all([ensureSecurityPreset(configured), ensureSecurityPreset(configured)])
  const path = join(user, SECURITY_PRESET, 'agent.cordis.yml'), before = await readFile(path, 'utf8')
  expect(before).toContain('@deepseek-ai/dsh-compaction-basic')
  await ensureSecurityPreset(configured)
  expect(await readFile(path, 'utf8')).toBe(before)
  await writeFile(path, before + '\n# User edit\n')
  await expect(ensureSecurityPreset(configured)).rejects.toThrow('security-preset-conflict')
  expect(await readFile(path, 'utf8')).toContain('# User edit')
})
it('does not replace unowned empty, partial or symlinked presets', async () => {
  const root = await fixture(), configured = [{ path: root, trust: 'user' as const }], destination = join(root, SECURITY_PRESET)
  await mkdir(destination)
  await expect(ensureSecurityPreset(configured)).rejects.toThrow('security-preset-conflict')
  await writeFile(join(destination, 'user.txt'), 'keep')
  await expect(ensureSecurityPreset(configured)).rejects.toThrow('security-preset-conflict')
  expect(await readFile(join(destination, 'user.txt'), 'utf8')).toBe('keep')
  const linked = join(await fixture(), 'presets'); await symlink(root, linked)
  await expect(ensureSecurityPreset([{ path: linked, trust: 'user' }])).rejects.toThrow('security-preset-conflict')
})
