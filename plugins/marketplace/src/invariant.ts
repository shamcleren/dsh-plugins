/** Package-owned invariant companion. @module @shamcleren/dsh-plugin-marketplace/invariant */

/* jscpd:ignore-start */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@shamcleren/dsh-plugin-marketplace'

/** Cordis companion plugin name. */
export const name = 'marketplace-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/** No runtime invariant: Catalog and artifact validation happen per operation. */
const install: InvariantInstaller = () => {}

/** Register this package's invariant companion. */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
/* jscpd:ignore-end */
