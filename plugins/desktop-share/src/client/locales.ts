export const en = {
  title: 'Shared files', openSession: 'Open a conversation first', add: 'Add to current conversation', adding: 'Adding…', folder: 'Open saved files',
  error: 'Could not import shared files. Originals remain saved locally.', busy: 'The composer is busy. Try again shortly.',
  ackError: 'Added to the draft, but saving the receipt failed. This share may reappear after a reload.',
  dismiss: 'Remove', dismissHint: 'Remove from pending shares; saved originals are retained.', dismissError: 'Could not remove the pending share. Try again.',
  inDraft: 'In draft', uploading: 'Uploading…', uploadError: 'Upload failed', retry: 'Retry', remove: 'Remove attachment', close: 'Close notice',
}
export const zh: typeof en = {
  title: '分享文件', openSession: '先打开一个会话', add: '加入当前对话', adding: '正在导入…', folder: '打开已保存文件',
  error: '导入失败，原始文件仍保存在本机。', busy: '输入框暂不可用，请稍后重试。',
  ackError: '已加入草稿，但接收状态保存失败。重新加载后可能再次显示。',
  dismiss: '移除', dismissHint: '从待处理分享中移除，保留已保存的原件。', dismissError: '移除失败，请重试。',
  inDraft: '已加入草稿', uploading: '正在上传…', uploadError: '上传失败', retry: '重试', remove: '移除附件', close: '关闭提示',
}
export type LocaleKey = keyof typeof en
