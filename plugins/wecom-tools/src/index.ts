import { fileURLToPath } from 'node:url'
import type { Context } from '@deepseek-ai/cordis'
import * as SkillFilesystem from '@deepseek-ai/dsh-skill-filesystem'

export const name = 'wecom-tools'
export const inject = ['skills']

/** Mount the pinned WeCom Unified Skill as a bundled, read-only provider. */
export function apply(ctx: Context): void {
  SkillFilesystem.apply(ctx, {
    providerName: name,
    includeDefaultRoots: false,
    bundledSkillDir: fileURLToPath(new URL('../skills', import.meta.url)),
    watch: false,
  })
}
