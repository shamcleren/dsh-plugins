/** Pure WeCom /answer prompt formatting and user answer parsing. */
import type { AskUserQuestionAnswerItem, AskUserQuestionItem } from './host-api.js'

export function currentQuestionIndex(
  questions: readonly AskUserQuestionItem[],
  answers: ReadonlyMap<string, AskUserQuestionAnswerItem>,
): number {
  return questions.findIndex(question => !answers.has(question.id))
}

export function answerUsage(questions: readonly AskUserQuestionItem[]): string {
  if (questions.length > 1) return '逐题回复 `/answer <题号> <答案>`。有选项时，可以用选项编号，例如 `/answer 1 1`。'
  if (!questions[0]?.options?.length) return '回复 `/answer <你的答案>`。'
  return '回复 `/answer 1` 选择第 1 项，也可以输入选项文字或自定义答案。'
}

export function formatWeComQuestions(questions: readonly AskUserQuestionItem[]): string {
  const rows = questions.map((question, questionIndex) => {
    const headline = `**第 ${questionIndex + 1} 题${question.header ? ` · ${question.header}` : ''}**`
    const options = (question.options ?? []).map((option, optionIndex) => {
      const description = option.description === undefined ? '' : ` — ${option.description}`
      return `- ${optionIndex + 1}）${option.label}${description}`
    })
    const multi = question.multiSelect === true ? '可用逗号选择多项，例如 `1,2`。' : ''
    return [headline, question.question, question.detail, options.join('\n'), multi].filter(Boolean).join('\n\n')
  })
  return ['需要你回答问题', answerUsage(questions), ...rows].join('\n\n')
}

function questionTarget(
  questions: readonly AskUserQuestionItem[],
  input: string,
): { question: AskUserQuestionItem; answerText: string } | undefined {
  if (input === '') return undefined
  if (questions.length === 1) {
    return { question: questions[0]!, answerText: input }
  }
  const separator = input.search(/\s/u)
  if (separator < 0) return undefined
  const selector = input.slice(0, separator)
  const answerText = input.slice(separator).trim()
  const number = Number(selector)
  const question = Number.isInteger(number) && number > 0
    ? questions[number - 1]
    : questions.find(candidate => candidate.id === selector)
  return question === undefined || answerText === '' ? undefined : { question, answerText }
}

function matchQuestionOptions(
  question: AskUserQuestionItem,
  answerText: string,
  questions: readonly AskUserQuestionItem[],
): AskUserQuestionAnswerItem | string {
  const options = question.options!
  if (!/^[0-9]+$/u.test(answerText)) {
    const exact = options.find(option => option.label === answerText)
    if (exact) return { id: question.id, selected: [exact.label] }
  }
  const selected: string[] = []
  const custom: string[] = []
  for (const token of answerText.split(/[,，]/u).map(part => part.trim()).filter(Boolean)) {
    const number = Number(token)
    const option = Number.isInteger(number) && number > 0
      ? options[number - 1]
      : options.find(candidate => candidate.label === token)
    if (option === undefined) custom.push(token)
    else if (!selected.includes(option.label)) selected.push(option.label)
  }
  if (selected.length === 0 && custom.length === 0) return answerUsage(questions)
  if (question.multiSelect !== true && selected.length + (custom.length > 0 ? 1 : 0) > 1) {
    return `“${question.id}”只能选择一个答案。`
  }
  return {
    id: question.id,
    selected,
    ...custom.length === 0 ? {} : { custom: custom.join('，') },
  }
}

export function parseWeComQuestionAnswer(
  questions: readonly AskUserQuestionItem[],
  input: string,
): AskUserQuestionAnswerItem | string {
  const target = questionTarget(questions, input)
  if (target === undefined) return answerUsage(questions)
  const options = target.question.options ?? []
  if (options.length === 0) {
    return { id: target.question.id, selected: [], custom: target.answerText }
  }
  return matchQuestionOptions(target.question, target.answerText, questions)
}
