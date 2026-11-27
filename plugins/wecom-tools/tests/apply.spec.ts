import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
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
    expect(candidates).toContainEqual(expect.objectContaining({
      name: 'wecom-unified',
      description: expect.stringMatching(/以授权人身份代发文本.*群聊历史/),
    }))
    const skill = await fiber.ctx.skills.get('wecom-unified')
    expect(skill).toMatchObject({ name: 'wecom-unified', provider: 'wecom-tools', source: 'bundled' })
    const base = skill?.resourceBase
    if (base?.kind !== 'directory') throw new Error('WeCom Skill references must use a local directory')

    const routes = [
      ['wecomcli-message-as-user.md', ['message send']],
      ['wecomcli-message.md', ['message aibot sessions list', 'message aibot send']],
      ['wecomcli-chat.md', ['chat groups list', 'chat messages list', 'message files get']],
    ] as const
    for (const [file, commands] of routes) {
      const reference = `references/${file}`
      expect(skill?.content).toContain(`(${reference})`)
      const guide = await readFile(join(base.path, reference), 'utf8')
      for (const command of commands) expect(guide).toContain(`wecom-cli ${command}`)
    }

    await fiber.dispose()
    expect(await skills.ctx.skills.list()).toEqual([])
    await ctx.fiber.dispose()
  })
})
