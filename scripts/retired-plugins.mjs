/** Explicit repository-owned retirements; absence from the catalog alone never authorizes removal. */
export const retiredPlugins = Object.freeze([
  Object.freeze({ id: 'codex-controller', package: '@shamcleren/dsh-codex-controller' }),
  Object.freeze({ id: 'wechat', package: '@shamcleren/dsh-wechat', replacement: 'im' }),
  Object.freeze({ id: 'wecom-aibot', package: '@shamcleren/dsh-wecom-aibot', replacement: 'im' }),
])

export function installedRetirements(manifest) {
  return retiredPlugins.filter(entry => Object.hasOwn(manifest?.dependencies ?? {}, entry.package))
}
