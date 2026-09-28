/** Trusted Marketplace plugin using the upstream Connection RPC extension. */
import type { Context, Volatile } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-connection'
import MarketplaceService from './service.ts'
import { createMarketplaceRpcHandler } from './rpc.ts'
import { registerHostRpc } from './host-rpc.ts'
export { parseMarketplaceCatalog } from './catalog.ts'
export type Config = import('./service.ts').Config
export const name = 'trusted-marketplace'
export const Config = MarketplaceService.Config
export const inject = ['credentials', 'webServer', 'connection', 'profileContext', 'pluginManager']

/** Mount the service and browser RPC with Host-enforced loopback authorization. */
export async function apply(ctx: Context, config: Config | Volatile<Config>): Promise<void> {
  // Keep the Profile's volatile reference; re-validating in a child plugin would
  // create a different configuration owner from the editable Host entry.
  const service = new MarketplaceService(ctx, config)
  if (ctx.webServer.host !== '127.0.0.1') throw new Error('Plugin management requires a loopback Web server')
  registerHostRpc(ctx, '/trusted-marketplace',
    createMarketplaceRpcHandler(service, error => { ctx.logger('trusted-marketplace').error(error) }))
}
