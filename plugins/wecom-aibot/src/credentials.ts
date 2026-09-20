import type { Context } from '@deepseek-ai/cordis'
import type { Config, WeComCredentials } from './config.js'
import { DEFAULT_BOT_ID_ENV, DEFAULT_SECRET_ENV } from './config.js'

interface CredentialResolver {
  resolve(ref: string): Promise<{ value: string } | undefined>
}

function credentialService(ctx: Context): CredentialResolver | undefined {
  return ctx.get('credentials') as unknown as CredentialResolver | undefined
}

async function resolveOne(ctx: Context, ref: string): Promise<string | undefined> {
  const resolved = await credentialService(ctx)?.resolve(ref)
  const value = resolved?.value ?? process.env[ref]
  return value === undefined || value.length === 0 ? undefined : value
}

/** Resolve the current credential-service or environment values for one Bot. */
export async function resolveCredentials(
  ctx: Context,
  config: Config,
): Promise<WeComCredentials | undefined> {
  const botId = await resolveOne(ctx, config.botIdEnv ?? DEFAULT_BOT_ID_ENV)
  const secret = await resolveOne(ctx, config.secretEnv ?? DEFAULT_SECRET_ENV)
  return botId === undefined || secret === undefined ? undefined : { botId, secret }
}

/** Subscribe to credential changes without importing a concrete provider package. */
export function onCredentialsUpdated(ctx: Context, listener: (ref: string) => void): () => void {
  const subscribe = ctx.on as unknown as (
    event: 'credentials/reference-updated',
    callback: (ref: string) => void,
  ) => () => void
  return subscribe.call(ctx, 'credentials/reference-updated', listener)
}
