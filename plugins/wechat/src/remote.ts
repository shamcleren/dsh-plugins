import type {
  RemoteResult,
  TypertRemoteContribution,
} from '@deepseek-ai/dsh-typert-protocol'
import { z } from 'zod'
import type { WeChatLoginView } from './login.js'

declare module '@deepseek-ai/dsh-typert-protocol' {
  interface WeChatLoginRemoteNamespace {
    state: () => Promise<RemoteResult<WeChatLoginView>>
    begin: () => Promise<RemoteResult<WeChatLoginView>>
    verify: (code: string) => Promise<RemoteResult<WeChatLoginView>>
    cancel: () => Promise<RemoteResult<WeChatLoginView>>
  }
  interface TypertRemoteMap {
    'wechatLogin/state': WeChatLoginRemoteNamespace['state']
    'wechatLogin/begin': WeChatLoginRemoteNamespace['begin']
    'wechatLogin/verify': WeChatLoginRemoteNamespace['verify']
    'wechatLogin/cancel': WeChatLoginRemoteNamespace['cancel']
  }
  interface TypertRemoteNamespaceMap {
    wechatLogin: WeChatLoginRemoteNamespace
  }
}

const accountSchema = z.union([
  z.object({ accountId: z.string(), userId: z.string() }),
  z.object({ accountId: z.string() }),
])

const receiverSchema = z.object({ status: z.enum(['waiting', 'starting', 'running', 'failed']), accounts: z.number().int().nonnegative() }).optional()

const loginViewSchema = z.discriminatedUnion('status', [
  z.object({ accounts: z.array(accountSchema), receiver: receiverSchema, status: z.literal('idle') }),
  z.object({
    accounts: z.array(accountSchema), receiver: receiverSchema,
    status: z.enum(['qr', 'scanned', 'verification-required']),
    flowId: z.string(),
    qrUrl: z.string(),
    expiresAt: z.number(),
  }),
  z.object({
    accounts: z.array(accountSchema), receiver: receiverSchema,
    status: z.literal('complete'),
    accountId: z.string(),
  }),
  z.object({
    accounts: z.array(accountSchema), receiver: receiverSchema,
    status: z.literal('failed'),
    message: z.string(),
  }),
]) satisfies z.ZodType<WeChatLoginView>

const loginViewCodec = {
  mode: 'strict' as const,
  typeSymbol: '@shamcleren/dsh-wechat#WeChatLoginView',
  schema: loginViewSchema,
}

const verificationCodeCodec = {
  mode: 'strict' as const,
  typeSymbol: '@shamcleren/dsh-wechat#VerificationCode',
  schema: z.string(),
}

/** Client contribution for the WeChat login Remote namespace. */
export const WECHAT_LOGIN_REMOTE: TypertRemoteContribution = {
  package: '@shamcleren/dsh-wechat',
  descriptors: [
    descriptor('state'),
    descriptor('begin'),
    descriptor('verify', [{ name: 'code', wire: 'code', source: 'json', codec: verificationCodeCodec }]),
    descriptor('cancel'),
  ],
}

function descriptor(
  method: 'state' | 'begin' | 'verify' | 'cancel',
  parameters: TypertRemoteContribution['descriptors'][number]['parameters'] = [],
): TypertRemoteContribution['descriptors'][number] {
  return {
    id: `@shamcleren/dsh-wechat#wechatLogin/${method}`,
    service: 'wechatLogin',
    namespace: 'wechatLogin',
    method,
    invocation: { kind: 'direct' },
    parameters,
    result: loginViewCodec,
  }
}

export default WECHAT_LOGIN_REMOTE
