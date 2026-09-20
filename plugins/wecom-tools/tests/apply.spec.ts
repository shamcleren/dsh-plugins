import { Context } from '@deepseek-ai/cordis'
import SkillRegistry from '@deepseek-ai/dsh-skill'
import { describe, expect, it } from 'vitest'
import * as WeComTools from '../src/index.js'

describe('WeCom tools bundle', () => {
  it('registers and retracts the pinned WeCom Unified Skill with its fiber', async () => {
    const ctx = new Context()
    const skills = await ctx.plugin(SkillRegistry)
    const fiber = await skills.ctx.plugin(WeComTools)

    const candidates = await fiber.ctx.skills.list()
    expect(candidates.map(candidate => candidate.name)).toContain('wecom-unified')
    await expect(fiber.ctx.skills.get('wecom-unified')).resolves.toMatchObject({
      name: 'wecom-unified', provider: 'wecom-tools', source: 'bundled',
    })

    await fiber.dispose()
    expect(await skills.ctx.skills.list()).toEqual([])
    await ctx.fiber.dispose()
  })
})
