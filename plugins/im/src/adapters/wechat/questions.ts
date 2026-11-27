/** Pure WeChat /answer prompt formatting and user answer parsing. */
import type { AskUserQuestionAnswerItem, AskUserQuestionItem } from './host-api.js'

function numberedAnswer(
  questions: readonly AskUserQuestionItem[],
  input: string,
): { question: AskUserQuestionItem; answer: string } | undefined {
  const separator = input.indexOf(' ')
  if (separator < 1) return undefined
  const selector = input.slice(0, separator)
  const question = questions[Number(selector) - 1] ?? questions.find(candidate => candidate.id === selector)
  return question === undefined ? undefined : { question, answer: input.slice(separator + 1).trim() }
}

export function parseWeChatQuestionAnswer(
  questions: readonly AskUserQuestionItem[],
  input: string,
): AskUserQuestionAnswerItem | string {
  if (input === '') return '请提供答案。'
  const target = questions.length === 1
    ? { question: questions[0]!, answer: input }
    : numberedAnswer(questions, input)
  if (target === undefined) return '多题回答格式：/answer <序号或 id> <答案>。'
  const options = target.question.options ?? []
  if (options.length === 0) return { id: target.question.id, selected: [], custom: target.answer }
  const requested = target.answer.split(',').map(entry => entry.trim()).filter(Boolean)
  const selected = requested.flatMap(entry => {
    const index = Number(entry)
    const option = Number.isInteger(index) && index > 0 ? options[index - 1] : options.find(candidate => candidate.label === entry)
    return option === undefined ? [] : [option.label]
  })
  if (selected.length !== requested.length) return `可选答案：${options.map((option, index) => `${index + 1}. ${option.label}`).join('；')}`
  return { id: target.question.id, selected: target.question.multiSelect === true ? selected : selected.slice(0, 1) }
}

export function formatWeChatQuestions(questions: readonly AskUserQuestionItem[]): string {
  return questions.map((question, index) => {
    const options = question.options?.map((option, optionIndex) => `  ${optionIndex + 1}. ${option.label}`).join('\n')
    return `${index + 1}. ${question.question}${options === undefined ? '' : `\n${options}`}`
  }).join('\n')
}
