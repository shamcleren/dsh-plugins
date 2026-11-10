/** Explicit repository-owned retirements; absence from the catalog alone never authorizes removal. */
export const retiredPlugins = Object.freeze([
  Object.freeze({ id: 'codex-controller', package: '@shamcleren/dsh-codex-controller' }),
])

export function installedRetirements(manifest) {
  return retiredPlugins.filter(entry => Object.hasOwn(manifest?.dependencies ?? {}, entry.package))
}
