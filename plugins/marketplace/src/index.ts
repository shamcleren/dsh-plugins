/** Trusted Marketplace plugin using the upstream Connection RPC extension. */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-connection'
import MarketplaceService from './service.ts'
import { createMarketplaceRpcHandler } from './rpc.ts'
import { registerHostRpc } from './host-rpc.ts'
export { parseMarketplaceCatalog } from './catalog.ts'
export type Config = import('./service.ts').Config
export const name = 'trusted-marketplace'
export const Config = MarketplaceService.Config
export const inject = ['credentials', 'webServer', 'connection']

/** Mount the service and browser RPC with Host-enforced loopback authorization. */
export async function apply(ctx: Context, config: import('./service.ts').Config): Promise<void> {
  const serviceFiber = await ctx.plugin(MarketplaceService, config)
  const service = serviceFiber.ctx.get('trustedMarketplace' as never) as unknown as MarketplaceService
  if (ctx.webServer.host !== '127.0.0.1') throw new Error('Plugin management requires a loopback Web server')
  registerHostRpc(ctx, '/trusted-marketplace',
    createMarketplaceRpcHandler(service, error => { ctx.logger('trusted-marketplace').error(error) }))
}
