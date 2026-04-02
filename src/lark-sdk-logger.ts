import type { Logger } from 'chat'

type LarkSdkLogMethod = (...msg: unknown[]) => void

interface LarkSdkLogger {
  debug: LarkSdkLogMethod
  error: LarkSdkLogMethod
  info: LarkSdkLogMethod
  trace: LarkSdkLogMethod
  warn: LarkSdkLogMethod
}

type ChatLogLevel = 'debug' | 'error' | 'info' | 'warn'
type LarkErrorMetadata = {
  code?: number
  logId?: string
  status?: number
  troubleshooter?: string
}

const DEFAULT_MESSAGE = 'Lark SDK log'
const SDK_CHILD_PREFIX = 'sdk'
const WS_SCOPE = 'ws'

const isWsScopeToken = (value: unknown): value is '[ws]' | 'ws' =>
  value === '[ws]' || value === 'ws'

const unwrapSdkPayload = (payload: unknown[]): unknown[] =>
  payload.length === 1 && Array.isArray(payload[0]) ? payload[0] : payload

const isScalarLogPart = (value: unknown): value is boolean | number | string =>
  typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean'

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null

const readObjectField = (
  value: Record<string, unknown> | undefined,
  key: string,
): Record<string, unknown> | undefined => {
  if (!value) {
    return undefined
  }
  const field = value[key]
  return isObject(field) ? field : undefined
}

const readNumberField = (
  value: Record<string, unknown> | undefined,
  key: string,
): number | undefined => {
  if (!value) {
    return undefined
  }
  const field = value[key]
  return typeof field === 'number' ? field : undefined
}

const readStringField = (
  value: Record<string, unknown> | undefined,
  key: string,
): string | undefined => {
  if (!value) {
    return undefined
  }
  const field = value[key]
  return typeof field === 'string' ? field : undefined
}

const extractPath = (url: string | undefined): string | undefined => {
  if (!url) {
    return undefined
  }
  try {
    const parsed = new URL(url)
    return `${parsed.pathname}${parsed.search}`
  } catch {
    return url
  }
}

const summarizeAxiosLarkError = (
  payload: unknown[],
): { args: unknown[]; message: string } | undefined => {
  const [first, second] = payload
  const error = isObject(first) ? first : undefined
  const responseData =
    (isObject(second) ? second : undefined) ??
    readObjectField(readObjectField(error, 'response'), 'data')

  if (!error || !responseData) {
    return undefined
  }

  const code = readNumberField(responseData, 'code')
  const msg = readStringField(responseData, 'msg')
  if (typeof code !== 'number' || !msg) {
    return undefined
  }

  const config = readObjectField(error, 'config')
  const method = readStringField(config, 'method')?.toUpperCase() ?? 'REQUEST'
  const path = extractPath(readStringField(config, 'url')) ?? 'unknown-url'
  const status =
    readNumberField(readObjectField(error, 'response'), 'status') ??
    readNumberField(responseData, 'status')
  const metadata: LarkErrorMetadata = {
    code,
    logId: readStringField(responseData, 'log_id'),
    status,
    troubleshooter: readStringField(responseData, 'troubleshooter'),
  }

  return {
    args: [metadata],
    message: `HTTP ${status ?? 'unknown'} ${method} ${path} -> Lark API ${code}: ${msg}`,
  }
}

const normalizePayload = (
  payload: unknown[],
): { args: unknown[]; message: string; scope?: typeof WS_SCOPE } => {
  const parts = [...unwrapSdkPayload(payload)]
  let scope: typeof WS_SCOPE | undefined

  if (isWsScopeToken(parts[0])) {
    scope = WS_SCOPE
    parts.shift()
  }

  const summarizedError = summarizeAxiosLarkError(parts)
  if (summarizedError) {
    return {
      args: summarizedError.args,
      message: summarizedError.message,
      scope,
    }
  }

  const messageParts: string[] = []
  const args: unknown[] = []

  for (const part of parts) {
    if (typeof part === 'string') {
      if (part.length > 0) {
        messageParts.push(part)
      }
      continue
    }

    if (isScalarLogPart(part)) {
      messageParts.push(String(part))
      continue
    }

    args.push(part)
  }

  return {
    args,
    message: messageParts.length > 0 ? messageParts.join(' ') : DEFAULT_MESSAGE,
    scope,
  }
}

const logWithLevel = (logger: Logger, level: ChatLogLevel, payload: unknown[]): void => {
  const { args, message, scope } = normalizePayload(payload)
  const target = scope === WS_SCOPE ? logger.child(WS_SCOPE) : logger

  switch (level) {
    case 'debug':
      target.debug(message, ...args)
      return
    case 'error':
      target.error(message, ...args)
      return
    case 'info':
      target.info(message, ...args)
      return
    case 'warn':
      target.warn(message, ...args)
      return
  }
}

const createLarkSdkLogger = (logger: Logger): LarkSdkLogger => {
  const sdkLogger = logger.child(SDK_CHILD_PREFIX)

  return {
    debug: (...payload: unknown[]) => {
      logWithLevel(sdkLogger, 'debug', payload)
    },
    error: (...payload: unknown[]) => {
      logWithLevel(sdkLogger, 'error', payload)
    },
    info: (...payload: unknown[]) => {
      logWithLevel(sdkLogger, 'info', payload)
    },
    trace: (...payload: unknown[]) => {
      logWithLevel(sdkLogger, 'debug', payload)
    },
    warn: (...payload: unknown[]) => {
      logWithLevel(sdkLogger, 'warn', payload)
    },
  }
}

export { createLarkSdkLogger }
