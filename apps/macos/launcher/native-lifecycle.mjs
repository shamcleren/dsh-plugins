/** Model-visible lifecycle guidance for the native App's owned Host. */
import { accessSync, constants } from 'node:fs'
import { fileURLToPath } from 'node:url'

export const name = 'dsh-native-lifecycle-policy'
export const inject = ['systemPrompt']

const quote = value => "'" + value.replaceAll("'", "'\\''") + "'"

export function apply(ctx) {
  const cli = fileURLToPath(new URL('../../../../bin/dhp', import.meta.url))
  const controller = fileURLToPath(new URL('../../MacOS/DeepSeekHarnessControl', import.meta.url))
  let command = quote(controller)
  try { accessSync(cli, constants.X_OK); command = quote(cli) + ' restart' } catch {}
  ctx.systemPrompt.section({
    name: 'dsh-native-lifecycle', order: 118,
    text: `当前 DSH Host 由 macOS 客户端管理。仅在用户授权的操作范围内管理它的生命周期。普通 cordis.patch.yml 修改先判断 profile 的 dsh.profile.patchReload：live（当前锁定运行时缺省值）支持热加载；startup 在下次启动生效。安装、更新、卸载插件或插件明确要求时，完成本批变更后统一重启一次。需要重启本客户端时，使用 ${command}，将请求交给仍然存活的客户端。不要用 kill、pkill、killall 或搜索进程后发送信号来重启 DSH，也不要直接运行内部 node/bin.js 或在 Bash 里先停止再后台启动：Host 退出会清理当前 Shell，后续命令不会可靠执行。重启会中断当前 AI 回合；先告知用户，恢复后可在原会话继续。不要自动重试已中断的有副作用操作。`,
  })
}
