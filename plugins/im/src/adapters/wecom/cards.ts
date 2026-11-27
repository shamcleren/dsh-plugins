/** Pure WeCom template-card builders, text width limits, and settled-card cache. */
import type { TemplateCard } from '@wecom/aibot-node-sdk'
import type { AskUserQuestionAnswerItem, AskUserQuestionItem } from './host-api.js'
import { currentQuestionIndex } from './questions.js'

const MAX_CARD_BUTTONS = 6
const QUESTION_CARD_TITLE_WIDTH = 26
const QUESTION_CARD_BODY_WIDTH = 30
const QUESTION_CARD_BUTTON_WIDTH = 10
const MAX_SETTLED_CARDS = 100

export interface ResolvedTemplateCard extends TemplateCard {
  replace_text: string
}

export interface SettledCard {
  userId: string
  title: string
}

/** Budget two units for non-ASCII characters to leave room on narrow clients. */
export function fitsQuestionCardLine(text: string, limit: number): boolean {
  if (/[\p{Cc}\p{Zl}\p{Zp}]/u.test(text)) return false
  let width = 0
  for (const character of text) {
    width += character.charCodeAt(0) <= 0x7e ? 1 : 2
    if (width > limit) return false
  }
  return true
}

export function limitCardText(text: string, characters: number): string {
  const content = [...text]
  return content.length <= characters
    ? text
    : `${content.slice(0, characters - 1).join('')}…`
}

export function parseCardSelection(eventKey: string): { questionIndex: number; optionIndex: number } | undefined {
  const matched = /^question_(\d+)_option_(\d+)$/u.exec(eventKey)
  if (matched === null) return undefined
  return { questionIndex: Number(matched[1]!), optionIndex: Number(matched[2]!) }
}

export function buildApprovalCard(
  taskId: string,
  toolName: string,
  reason?: string,
  command?: string,
): TemplateCard {
  return {
    card_type: 'button_interaction',
    main_title: { title: '需要审批', desc: limitCardText(`工具：${toolName}`, 30) },
    ...reason === undefined ? {} : { sub_title_text: limitCardText(reason, 112) },
    ...command === undefined ? {} : {
      quote_area: {
        type: 0,
        title: '执行命令',
        quote_text: command,
      },
    },
    button_list: [
      { text: '允许', key: 'approval_allow', style: 1 },
      { text: '拒绝', key: 'approval_reject', style: 2 },
    ],
    task_id: taskId,
  }
}

export function buildQuestionCard(
  taskId: string,
  questions: readonly AskUserQuestionItem[],
  answers: ReadonlyMap<string, AskUserQuestionAnswerItem>,
): TemplateCard | undefined {
  const questionIndex = currentQuestionIndex(questions, answers)
  const question = questions[questionIndex]
  const options = question?.options ?? []
  if (question === undefined || question.multiSelect === true
    || options.length === 0 || options.length > MAX_CARD_BUTTONS) return undefined
  const title = question.header?.trim() || '请选择答案'
  if (!fitsQuestionCardLine(title, QUESTION_CARD_TITLE_WIDTH)
    || !fitsQuestionCardLine(question.question, QUESTION_CARD_BODY_WIDTH)
    || !fitsQuestionCardLine(question.detail ?? '', QUESTION_CARD_BODY_WIDTH)
    || options.some(option => !option.label.trim() || !fitsQuestionCardLine(option.label, QUESTION_CARD_BUTTON_WIDTH)
      || !fitsQuestionCardLine(option.description ?? '', QUESTION_CARD_BODY_WIDTH))) return undefined
  return {
    card_type: 'button_interaction',
    main_title: { title, desc: question.question },
    button_list: options.map((option, index) => ({
      text: option.label,
      key: `question_${questionIndex}_option_${index}`,
      style: index === 0 ? 1 : 2,
    })),
    task_id: taskId,
  }
}

export function buildResolvedCard(taskId: string, title: string, description?: string): ResolvedTemplateCard {
  return {
    card_type: 'button_interaction',
    main_title: {
      title: limitCardText(title, 26),
      ...description === undefined ? {} : { desc: limitCardText(description, 30) },
    },
    card_action: { type: 0 },
    button_list: [{ text: '已处理', key: 'resolved_noop', style: 2 }],
    replace_text: '操作成功',
    task_id: taskId,
  }
}

/** Bounded FIFO cache remembering recently settled cards so late button clicks update cleanly. */
export class SettledCardStore {
  private readonly items = new Map<string, SettledCard>()

  remember(taskId: string, userId: string, title: string): void {
    if (this.items.size >= MAX_SETTLED_CARDS) {
      const oldestTaskId = this.items.keys().next().value as string
      this.items.delete(oldestTaskId)
    }
    this.items.set(taskId, { userId, title })
  }

  take(taskId: string, userId: string): SettledCard | undefined {
    const settled = this.items.get(taskId)
    if (settled?.userId !== userId) return undefined
    this.items.delete(taskId)
    return settled
  }

  clear(): void {
    this.items.clear()
  }
}
