import { describe, expect, it } from 'vitest'
import { runCommand } from '../src/command.ts'

describe('runCommand', () => {
  it('retains pnpm diagnostics emitted on stdout when a command fails', async () => {
    await expect(runCommand(process.execPath, ['-e', 'process.stdout.write("ERR_PNPM_UNEXPECTED_STORE"); process.exit(1)'], {}, 1024))
      .rejects.toThrow('ERR_PNPM_UNEXPECTED_STORE')
  })
  it('captures bounded bytes without inheriting stdin', async () => {
    const result = await runCommand(process.execPath, ['-e', 'process.stdout.write("catalog")'], process.env, 64)
    expect(result.stdout.toString('utf8')).toBe('catalog')
    expect(result.stderr).toBe('')
  })

  it('rejects nonzero exit without exposing environment values', async () => {
    await expect(runCommand(
      process.execPath,
      ['-e', 'process.stderr.write("refused"); process.exit(2)'],
      { ...process.env, GONGFENG_TOKEN: 'secret-never-rendered' },
      1024,
    )).rejects.toThrow(/^marketplace command failed with 2: refused$/)
  })
})
