import type { Context } from '@deepseek-ai/cordis'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import type {} from '@deepseek-ai/dsh-workspace'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type {} from '@deepseek-ai/dsh-client-connection'
import { WorkspaceService } from './service.js'
import { registerRpc } from './web.js'

export const name = 'github-workspace'
export const inject = ['connection', 'webServer', 'workspaceRegistry']
export async function apply(ctx: Context): Promise<void> {
  if (ctx.webServer.host !== '127.0.0.1') throw new Error('GitHub Workspace requires a loopback Web server')
  const service = await WorkspaceService.create(resolveDshHome(), ctx.workspaceRegistry)
  ctx.effect(() => () => service.stop(), 'github-workspace: commands and login')
  registerRpc(ctx, service)
}
