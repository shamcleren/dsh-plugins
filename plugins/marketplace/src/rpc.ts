/** Validated public methods; installation remains restricted to the trusted catalog. */
import type { ConnectionRpcHandler } from '@deepseek-ai/dsh-client-connection'
import { z } from 'zod'
import type MarketplaceService from './service.ts'

type BrowserService = Pick<MarketplaceService, 'state' | 'catalog' | 'refreshCatalog' | 'configure' | 'add' | 'deletePackage' | 'beginOAuth' | 'oauthStatus'>
const empty = z.strictObject({})
const packageRequest = z.strictObject({ packageName: z.string().min(1) })
const source = z.strictObject({ repositoryUrl: z.string().url() })

/** Create an allowlisted handler for the human-operated settings page. */
export function createMarketplaceRpcHandler(service: BrowserService, report: (error: unknown) => void): ConnectionRpcHandler {
  return async (endpoint, payload) => {
    try {
      let value: unknown
      switch (endpoint) {
        case 'state': empty.parse(payload); value = await service.state(); break
        case 'catalog': empty.parse(payload); value = await service.catalog(); break
        case 'refreshCatalog': empty.parse(payload); value = await service.refreshCatalog(); break
        case 'configure': value = await service.configure(source.parse(payload)); break
        case 'add': value = await service.add(packageRequest.parse(payload).packageName); break
        case 'deletePackage': value = await service.deletePackage(packageRequest.parse(payload).packageName); break
        case 'beginOAuth': value = await service.beginOAuth(source.parse(payload)); break
        case 'oauthStatus': value = await service.oauthStatus(z.strictObject({ flowId: z.string().min(1) }).parse(payload).flowId); break
        default: return { ok: false, error: { code: 'bad-request', message: 'Unknown Marketplace operation', details: { issues: [] } } }
      }
      return { ok: true, value }
    } catch (error) {
      report(error)
      if (error instanceof z.ZodError) return { ok: false, error: {
        code: 'bad-request', message: 'Invalid Marketplace request', details: { issues: error.issues },
      } }
      return { ok: false, error: { code: 'internal', message: 'Marketplace operation failed; check the Host log.', details: {} } }
    }
  }
}
