/** Display common Markdown blocks on a narrow chat surface; retain inline syntax verbatim. */
const listItem = /^([ \t]*)([-+*]|\d{1,9}[.)])([ \t]+)(.*)$/u
const rule = /^ {0,3}(?:(?:\*[ \t]*){3,}|(?:-[ \t]*){3,}|(?:_[ \t]*){3,})$/u
const fence = /^(?:[ \t]*>[ \t]?)*[ \t]*(`{3,}|~{3,})(.*)$/u
const fenceClose = (marker: string) => new RegExp('^(?:[ \\t]*>[ \\t]?)*[ \\t]*' + marker[0] + '{' + marker.length + ',}[ \\t]*$')

/** Locate a matching run without treating a longer run as its closing delimiter. */
function codeEnd(text: string, start: number): number {
  let size = 1
  while (text[start + size] === '`') size++
  const marker = '`'.repeat(size)
  let next = text.indexOf(marker, start + size)
  while (next >= 0) {
    if (text[next - 1] !== '`' && text[next + size] !== '`') return next + size
    next = text.indexOf(marker, next + size)
  }
  return start + size
}

function delimiterEnds(text: string): Map<number, number> {
  const ends = new Map<number, number>(), brackets: number[] = [], parentheses: number[] = []
  for (let index = 0; index < text.length; index++) {
    if (text[index] === '\\') index++
    else if (text[index] === '`') index = codeEnd(text, index) - 1
    else if (text[index] === '[') brackets.push(index)
    else if (text[index] === '(') parentheses.push(index)
    else if (text[index] === ']' || text[index] === ')') {
      const start = (text[index] === ']' ? brackets : parentheses).pop()
      if (start !== undefined) ends.set(start, index + 1)
    }
  }
  return ends
}

function cells(line: string): string[] | undefined {
  const text = line.trim(), result: string[] = []
  if (!text.includes('|')) return undefined
  const ends = delimiterEnds(text)
  let cell = '', pipes = 0, lastPipe = -1
  for (let index = 0; index < text.length; index++) {
    const char = text[index]!
    if (char === '\\' && index + 1 < text.length) {
      const escaped = text[++index]!
      cell += escaped === '|' ? '|' : '\\' + escaped
    } else if (char === '`') {
      const end = codeEnd(text, index)
      cell += text.slice(index, end); index = end - 1
    } else if (char === '[') {
      let end = ends.get(index) ?? index + 1
      if (end > index + 1 && text[end] === '(') end = ends.get(end) ?? end
      cell += text.slice(index, end); index = end - 1
    } else if (char === '<' && /^<(?:https?:\/\/|mailto:)/iu.test(text.slice(index)) && text.indexOf('>', index) >= 0) {
      const end = text.indexOf('>', index) + 1
      cell += text.slice(index, end); index = end - 1
    } else if (char === '|') {
      result.push(cell.trim()); cell = ''; pipes++; lastPipe = index
    } else cell += char
  }
  if (!pipes) return undefined
  result.push(cell.trim())
  if (text.startsWith('|')) result.shift()
  if (lastPipe === text.length - 1) result.pop()
  return result
}

function table(lines: string[], start: number): { text: string; end: number } | undefined {
  const header = cells(lines[start]!), separator = cells(lines[start + 1] ?? '')
  if (!header?.length || !separator || separator.length !== header.length
    || !separator.every(cell => /^:?-+:?$/u.test(cell))) return undefined
  const rows: string[][] = []
  let end = start + 2
  while (end < lines.length && lines[end]!.trim() !== '') {
    const row = cells(lines[end]!)
    if (!row || fence.test(lines[end]!)) break
    rows.push(row); end++
  }
  const label = (index: number) => header[index] || `列 ${index + 1}`
  // Keep extra cells too: dropping an unexpected field would lose user information.
  const text = rows.length ? rows.map(row => '- ' +
    Array.from({ length: Math.max(header.length, row.length) }, (_, column) =>
      `${label(column)}：${row[column] ?? ''}`).join('；')).join('\n')
    : header.map((_, index) => label(index)).join(' / ')
  return { text, end }
}

export function formatWeChatReply(markdown: string): string {
  const lines = markdown.replace(/\r\n?/gu, '\n').split('\n')
  const output: Array<{ text: string; literal: boolean; heading?: boolean }> = []
  const append = (text: string, literal = false) => {
    for (const line of text.split('\n')) {
      if (!literal && line === '' && output.at(-1)?.text === '' && !output.at(-1)?.literal) continue
      output.push({ text: line, literal, ...!literal && /^【[^】\n]+】$/u.test(line) ? { heading: true } : {} })
    }
  }
  const headingBlock = (text: string) => {
    if (output.at(-1)?.text.trim()) append('')
    append(`【${text}】`)
  }
  const indentation = (text: string) => /^(?:[ \t]*)/u.exec(text)![0].replace(/\t/gu, '    ').length
  let inList = false, contentIndent = 0
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]!, item = listItem.exec(line)
    const opening = fence.exec(line) ?? (item ? fence.exec(item[4]!) : null)
    if (opening) {
      const closing = fenceClose(opening[1]!)
      const raw = [line]
      while (++index < lines.length) {
        raw.push(lines[index]!)
        if (closing.test(lines[index]!)) break
      }
      append(raw.join('\n'), true); inList = false
      continue
    }
    // Indented code is literal, including apparent headings/tables inside it.
    const codeIndent = inList ? contentIndent + 4 : 4
    if (line.trim() && indentation(line) >= codeIndent) {
      const raw = [line]
      while (index + 1 < lines.length && (indentation(lines[index + 1]!) >= codeIndent || lines[index + 1] === '')) raw.push(lines[++index]!)
      append(raw.join('\n'), true)
      continue
    }
    const grid = table(lines, index)
    if (grid) { append(grid.text); index = grid.end - 1; inList = false; continue }
    const heading = /^ {0,3}#{1,6}[ \t]+(.+?)(?:[ \t]+#+)?[ \t]*$/u.exec(line)
    if (heading) { headingBlock(heading[1]!); inList = false; continue }
    if (line.trim() && !item && !/^\s*>/u.test(line) && /^ {0,3}(?:=+|-+)[ \t]*$/u.test(lines[index + 1] ?? '')) {
      headingBlock(line.trim()); index++; inList = false; continue
    }
    if (rule.test(line)) { append('────────'); append(''); inList = false; continue }
    if (item) {
      const marker = /^\d/u.test(item[2]!) ? item[2]!.replace(/[.)]$/u, '.') : '-'
      const text = item[4]!.replace(/^\[([ xX])\][ \t]+/u, (_, checked: string) => checked === ' ' ? '☐ ' : '☑ ')
      // Native Markdown list markers preserve rows/nesting on PC WeChat;
      // Unicode bullets plus hard-break spaces are folded into one paragraph.
      append(`${item[1]}${marker} ${text}`); inList = true
      contentIndent = indentation(item[1]!) + item[2]!.length + item[3]!.replace(/\t/gu, '    ').length
    } else {
      append(line)
      if (line.trim() && !/^[ \t]/u.test(line)) inList = false
    }
  }
  const compact: typeof output = []
  const isItem = (entry: (typeof output)[number] | undefined) =>
    entry && !entry.literal ? listItem.exec(entry.text) : null
  for (let index = 0; index < output.length; index++) {
    const entry = output[index]!
    if (entry.heading) {
      let next = index + 1
      while (output[next] && !output[next]!.literal && !output[next]!.text.trim()) next++
      const body = output[next]
      // A section label and its first prose line need only one paragraph.
      if (body && !body.literal && !body.heading && !isItem(body) && !rule.test(body.text)
        && !/^ {0,3}(?:>|<|\[[^\]]+\]:)/u.test(body.text)) {
        compact.push({ text: `${entry.text} ${body.text.trimStart()}`, literal: false })
        index = next
      } else {
        compact.push(entry)
        const item = isItem(body)
        if (next === index + 1 && item && /^\d/u.test(item[2]!) && !/^1[.)]$/u.test(item[2]!)) {
          compact.push({ text: '', literal: false })
        }
      }
      continue
    }
    if (!entry.literal && !entry.text.trim()) {
      const previous = compact.at(-1), next = output[index + 1], item = isItem(next)
      const interruptsParagraph = item && (!/^\d/u.test(item[2]!) || /^1[.)]$/u.test(item[2]!))
      // Tighten list boundaries without joining prose after a list to its last item.
      // Blank lines before literal code and non-1 ordered starts remain significant.
      if (!previous || !next || (item && (isItem(previous) || (interruptsParagraph && !previous.literal)))) continue
    }
    compact.push(entry)
  }
  return compact.map(({ text, literal }) => literal ? text : text.replace(/[ \t]+$/u, '')).join('\n')
}

function fencedRanges(text: string): Array<{ start: number; end: number }> {
  const ranges: Array<{ start: number; end: number }> = []
  let start = 0, offset = 0, closing: RegExp | undefined
  for (const line of text.split('\n')) {
    if (closing) {
      if (closing.test(line)) { ranges.push({ start, end: offset + line.length }); closing = undefined }
    } else {
      const item = listItem.exec(line), opening = fence.exec(line) ?? (item ? fence.exec(item[4]!) : null)
      if (opening) { start = offset; closing = fenceClose(opening[1]!) }
    }
    offset += line.length + 1
  }
  if (closing) ranges.push({ start, end: text.length })
  return ranges
}

/** Prefer complete paragraphs/lines, retaining every character and whole UTF-16 pairs. */
export function weChatTextChunks(text: string, limit = 4_000): string[] {
  if (!Number.isSafeInteger(limit) || limit < 2) throw new RangeError('Invalid message limit')
  const chunks: string[] = [], code = fencedRanges(text)
  let offset = 0
  while (offset < text.length) {
    let end = Math.min(offset + limit, text.length)
    if (end < text.length) {
      const window = text.slice(offset, end), minimum = Math.floor(limit / 2)
      const paragraph = window.lastIndexOf('\n\n'), line = window.lastIndexOf('\n')
      if (paragraph >= minimum) end = offset + paragraph + 2
      else if (line >= minimum) end = offset + line + 1
      const block = code.find(block => block.start < end && block.end > end && block.end - block.start <= limit)
      if (block && block.start >= offset) end = block.start > offset ? block.start : block.end
      const last = text.charCodeAt(end - 1), next = text.charCodeAt(end)
      if (last >= 0xd800 && last <= 0xdbff && next >= 0xdc00 && next <= 0xdfff) end--
    }
    chunks.push(text.slice(offset, end)); offset = end
  }
  return chunks
}
