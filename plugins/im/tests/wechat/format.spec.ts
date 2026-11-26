import { expect, it } from 'vitest'
import { formatWeChatReply, weChatTextChunks } from '../../src/adapters/wechat/format.js'

it('separates headings, preserves inline links/emphasis/code, and does not reinterpret hashes in prose', () => {
  const text = '# **结论**\n\n看 [说明](https://example.test/a_b?q=1&x=2) 和 `a_b`。\n下一行 C#。\n\n细节\n====\n\n## 安排 ##\n\n完成。'
  expect(formatWeChatReply(text)).toBe('【**结论**】 看 [说明](https://example.test/a_b?q=1&x=2) 和 `a_b`。\n下一行 C#。\n\n【细节】\n\n【安排】 完成。')
})

it('retains explicit list numbers, nesting and task completion without client renumbering', () => {
  expect(formatWeChatReply('3. 第一项\n   - 子项\n4) [x] 完成\n5. [ ] 待办')).toBe(
    '3. 第一项\n   - 子项\n4. ☑ 完成\n5. ☐ 待办')
})

it('turns a wide table into separate records with all labeled fields, including empty and extra cells', () => {
  expect(formatWeChatReply('| 日期 | 安排 | 金额 |\n| :--- | --- | ---: |\n| 周四 | 上海 | 0 |\n| 周五 | | 12 | 备注 |')).toBe(
    '- 日期：周四；安排：上海；金额：0\n- 日期：周五；安排：；金额：12；列 4：备注')
})

it('preserves pipes inside escaped text, code spans and link destinations', () => {
  expect(formatWeChatReply('名称 | 值\n--- | ---\nA\\|B | ``a|b``\n[链接](https://example.test/a_(b)|c) | `x\\|y`')).toBe(
    '- 名称：A|B；值：``a|b``\n- 名称：[链接](https://example.test/a_(b)|c)；值：`x\\|y`')
})

it.each([
  'a | b\n-- nope | ---\nc | d',
  'a | b\n--- | --- | ---\nc | d',
  'https://example.test/a_b#part',
  '转义 \\# 标题，计算 a | b，路径 foo_bar。',
])('does not invent table structure for ordinary or unsupported syntax: %s', text => {
  const result = formatWeChatReply(text)
  expect(result.replace(/ {2}\n/gu, '\n')).toBe(text)
})

it('keeps an empty table header visible and does not consume a following paragraph', () => {
  expect(formatWeChatReply('| A | B |\n| --- | --- |\n\n后续内容')).toBe('A / B\n\n后续内容')
})

it.each([
  '```md\n# literal\n- a\n| a | b |\n| --- | --- |\n```',
  '~~~~md\n### literal\n~~~\n- a\n~~~~',
  '````md\n```\n# still code\n````',
  '```md\n# unfinished\n- unchanged',
  '> ```md\n> # literal\n> - a\n> ```',
  '- ```md\n  # literal\n  - a\n  ```',
  '    # literal\n    1. unchanged\n    | a | b |\n    | --- | --- |',
])('leaves code blocks and their internal whitespace intact: %s', code => {
  expect(formatWeChatReply(code)).toBe(code)
})

it('keeps code within a list literal and resumes formatting after its fence', () => {
  expect(formatWeChatReply('- 例子\n  ```md\n  ## literal\n  ```\n\n## 结果\n\n已完成。')).toBe(
    '- 例子\n  ```md\n  ## literal\n  ```\n\n【结果】 已完成。')
  expect(formatWeChatReply('- 例子\n\n      # literal\n      - still code')).toBe('- 例子\n\n      # literal\n      - still code')
})

it('keeps blank lines inside code while bounding repeated prose gaps', () => {
  expect(formatWeChatReply('开始\n\n\n\n```txt\na\n\n\nb\n```\n\n\n结束')).toBe('开始\n\n```txt\na\n\n\nb\n```\n\n结束')
})

it('avoids PC WeChat soft-break padding while preserving whitespace inside code', () => {
  const formatted = formatWeChatReply('## 清单\n\n- 一级  \n  - 二级  \n\n| A | B |\n| --- | --- |\n| 1 | 2 |\n| 3 | 4 |')
  expect(formatted).toBe('【清单】\n- 一级\n  - 二级\n- A：1；B：2\n- A：3；B：4')
  expect(formatted).not.toMatch(/\u3000|[ \t]+\n/u)
  expect(formatWeChatReply('```txt\n  literal  \n```')).toBe('```txt\n  literal  \n```')
})

it('reduces section paragraphs and loose list gaps without flattening separate prose', () => {
  const source = '# 概览\n\n简短说明。\n\n## 清单\n\n- 第一项\n\n- 第二项\n\n下一段正文。\n\n最后一段正文。'
  expect(formatWeChatReply(source)).toBe('【概览】 简短说明。\n\n【清单】\n- 第一项\n- 第二项\n\n下一段正文。\n\n最后一段正文。')
})

it('keeps ordered lists starting at a later step and literal code as separate blocks', () => {
  expect(formatWeChatReply('# 步骤\n3. 第三步\n4. 第四步')).toBe('【步骤】\n\n3. 第三步\n4. 第四步')
  expect(formatWeChatReply('## 示例\n\n```txt\na\n\n\nb  \n```')).toBe('【示例】\n\n```txt\na\n\n\nb  \n```')
  expect(formatWeChatReply('## 示例\n\n    a\n\n    b')).toBe('【示例】\n\n    a\n\n    b')
})

it('chunks at paragraphs or lines and preserves every character including emoji', () => {
  const paragraph = 'a'.repeat(3000) + '\n\n', line = 'b'.repeat(2500) + '\n'
  const text = paragraph + line + '🧭'.repeat(2501)
  const chunks = weChatTextChunks(text)
  expect(chunks[0]).toBe(paragraph)
  expect(chunks[1]).toBe(line)
  expect(chunks.join('')).toBe(text)
  expect(chunks.every(chunk => chunk.length <= 4000 && !/^[\uDC00-\uDFFF]|[\uD800-\uDBFF]$/u.test(chunk))).toBe(true)
})

it('handles an unbroken long line without splitting a surrogate pair or dropping text', () => {
  const text = 'a'.repeat(3999) + '🧭' + 'b'.repeat(4001)
  expect(weChatTextChunks(text)).toEqual(['a'.repeat(3999), '🧭' + 'b'.repeat(3998), 'bbb'])
  expect(weChatTextChunks('')).toEqual([])
  expect(() => weChatTextChunks('x', 1)).toThrow(RangeError)
})

it('keeps a fenced code block that fits in one message whole, even after a short introduction', () => {
  const introduction = '介绍。'.repeat(100) + '\n\n', code = '```txt\n' + 'x\n'.repeat(1900) + '```'
  const text = introduction + code + '\n\n' + '尾注'.repeat(100)
  const chunks = weChatTextChunks(text)
  expect(chunks[0]).toBe(introduction)
  expect(chunks[1]).toContain(code)
  expect(chunks.join('')).toBe(text)
  expect(chunks.every(chunk => chunk.length <= 4000)).toBe(true)
})

it('still bounds messages for code exceeding the protocol limit without altering its content', () => {
  const text = '~~~txt\n' + '🧭 data\n'.repeat(1200) + '~~~'
  const chunks = weChatTextChunks(text)
  expect(chunks.length).toBeGreaterThan(1)
  expect(chunks.join('')).toBe(text)
  expect(chunks.every(chunk => chunk.length <= 4000)).toBe(true)
})
