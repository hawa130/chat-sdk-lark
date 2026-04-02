import { AppType, Domain } from '@larksuiteoapi/node-sdk'
import { LarkAdapter } from './adapter.ts'
import type { LarkAdapterConfig, LarkIncomingConfig } from './types.ts'
import { ValidationError } from '@chat-adapter/shared'

const ADAPTER_NAME = 'lark'

const resolveDomain = (
  value: Domain | string | undefined,
  source: 'config.domain' | 'LARK_DOMAIN',
): Domain | undefined => {
  if (value === Domain.Lark || value === 'lark') {
    return Domain.Lark
  }
  if (value === Domain.Feishu || value === 'feishu' || value === undefined) {
    return Domain.Feishu
  }
  throw new ValidationError(
    ADAPTER_NAME,
    `Invalid ${source}: expected "feishu" or "lark", got "${String(value)}"`,
  )
}

const resolveIncoming = (incoming?: LarkIncomingConfig): Required<LarkIncomingConfig> => ({
  callbacks: incoming?.callbacks ?? 'webhook',
  events: incoming?.events ?? 'webhook',
})

const validateIncoming = (
  incoming: Required<LarkIncomingConfig>,
  appType: AppType | undefined,
): void => {
  if ((incoming.events === 'ws' || incoming.callbacks === 'ws') && appType === AppType.ISV) {
    throw new ValidationError(
      ADAPTER_NAME,
      'WS incoming transport is only available for self-built apps',
    )
  }
}

const resolveConfig = (config?: Partial<LarkAdapterConfig>): LarkAdapterConfig => {
  const appId = config?.appId ?? process.env['LARK_APP_ID']
  const appSecret = config?.appSecret ?? process.env['LARK_APP_SECRET']
  const incoming = resolveIncoming(config?.incoming)
  const appType = config?.appType

  validateIncoming(incoming, appType)

  if (!appId) {
    throw new ValidationError(ADAPTER_NAME, 'Missing required config: LARK_APP_ID')
  }
  if (!appSecret) {
    throw new ValidationError(ADAPTER_NAME, 'Missing required config: LARK_APP_SECRET')
  }

  return {
    appId,
    appSecret,
    domain:
      config?.domain !== undefined
        ? resolveDomain(config.domain, 'config.domain')
        : resolveDomain(process.env['LARK_DOMAIN'], 'LARK_DOMAIN'),
    encryptKey: config?.encryptKey ?? process.env['LARK_ENCRYPT_KEY'],
    verificationToken: config?.verificationToken ?? process.env['LARK_VERIFICATION_TOKEN'],
    ...(config?.userName !== undefined && { userName: config.userName }),
    ...(config?.disableTokenCache !== undefined && {
      disableTokenCache: config.disableTokenCache,
    }),
    ...(config?.appType !== undefined && { appType: config.appType }),
    ...(config?.cache !== undefined && { cache: config.cache }),
    ...(config?.httpInstance !== undefined && { httpInstance: config.httpInstance }),
    ...(config?.logger !== undefined && { logger: config.logger }),
    ...(config?.streamingSummary !== undefined && { streamingSummary: config.streamingSummary }),
    incoming,
    userInfoResolution: config?.userInfoResolution ?? 'lazy',
    ...(config?.ws !== undefined && { ws: config.ws }),
  }
}

const createLarkAdapter = (config?: Partial<LarkAdapterConfig>): LarkAdapter =>
  new LarkAdapter(resolveConfig(config))

export { createLarkAdapter }
