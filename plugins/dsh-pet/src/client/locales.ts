/** Browser copy owned by the desktop-pet plugin. */

export const en = {
  title: 'Desktop Pet',
  description: 'Configure the desktop floating pet.',
  enabled: 'Enable desktop pet',
  enabledHint: 'Show or hide the floating pet window.',
  on: 'Enabled',
  off: 'Disabled',
  pet: 'Pet',
  petHint: 'Select the pet to display. Copy packs into the desktop-pet packs directory to add more.',
  petsLoading: 'Loading pets…',
  petsError: 'Could not load pets from the desktop-pet packs directory.',
  petsEmpty: 'No pets found. Copy a Codex pet pack into the desktop-pet packs directory.',
  petSize: 'Pet size (px)',
  petSizeHint: 'Sprite width in pixels, 80–224.',
  invalid: 'Enter a valid value.',
  readOnly: 'This deployment stores settings read-only.',
} as const

export const zh: Record<keyof typeof en, string> = {
  title: '桌面宠物',
  description: '配置桌面悬浮宠物。',
  enabled: '启用桌面宠物',
  enabledHint: '显示或隐藏悬浮宠物窗口。',
  on: '已启用',
  off: '未启用',
  pet: '宠物',
  petHint: '选择要显示的宠物。将宠物包复制到 desktop-pet 的 packs 目录即可添加。',
  petsLoading: '正在加载宠物…',
  petsError: '无法从 desktop-pet 的 packs 目录加载宠物。',
  petsEmpty: '未找到宠物。请将 Codex 宠物包复制到 desktop-pet 的 packs 目录。',
  petSize: '宠物尺寸（像素）',
  petSizeHint: '精灵宽度像素，80–224。',
  invalid: '请输入有效值。',
  readOnly: '本部署的设置为只读。',
}

export type LocaleKey = keyof typeof en
