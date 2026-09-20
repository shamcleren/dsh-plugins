import type { InstalledPlugin, MarketplacePlugin } from './types.ts'
import { gt, valid } from 'semver'

export type CatalogFilter = 'all' | 'compatible' | 'updates'

/** One catalog entry joined with its installed state. */
export interface PluginRow {
  readonly plugin: MarketplacePlugin
  readonly installed?: InstalledPlugin
  readonly updateAvailable: boolean
}

/** Join catalog and installed entries without depending on their display order. */
export function pluginRows(
  plugins: readonly MarketplacePlugin[],
  installed: readonly InstalledPlugin[],
): PluginRow[] {
  const installedByName = new Map(installed.map(entry => [entry.packageName, entry]))
  return plugins.map((plugin) => {
    const current = installedByName.get(plugin.packageName)
    return {
      plugin,
      ...(current === undefined ? {} : { installed: current }),
      updateAvailable: plugin.compatible && current !== undefined && (current.version === undefined ||
        (valid(current.version) !== null && valid(plugin.version) !== null && gt(plugin.version, current.version))),
    }
  })
}

/** Apply query and compatibility/update filters with stable catalog ordering. */
export function visibleRows(rows: readonly PluginRow[], query: string, filter: CatalogFilter): PluginRow[] {
  const normalized = query.trim().toLocaleLowerCase()
  return rows.filter((row) => {
    if (filter === 'compatible' && !row.plugin.compatible) return false
    if (filter === 'updates' && !row.updateAvailable) return false
    return normalized === '' || [row.plugin.name, row.plugin.packageName, row.plugin.description]
      .some(value => value.toLocaleLowerCase().includes(normalized))
  })
}
