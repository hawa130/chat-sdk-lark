import type { LarkWebhookBody } from './types.ts'
import { CardActionHandler, EventDispatcher, generateChallenge } from '@larksuiteoapi/node-sdk'

type BridgeDispatcher = CardActionHandler | EventDispatcher
type RequestValidator = {
  checkIsCardEventValidated?: (data: Record<string, unknown>) => boolean
  checkIsEventValidated?: (data: Record<string, unknown>) => boolean
}
type LarkBridgedRequest = Record<string, unknown> & {
  headers: Record<string, string>
}

const parseBody = async (request: Request): Promise<LarkWebhookBody> => {
  const body = await request.text()
  try {
    return JSON.parse(body) as LarkWebhookBody
  } catch {
    throw new Error('Invalid JSON body')
  }
}

const buildWebhookRequest = async (request: Request): Promise<LarkBridgedRequest> => {
  const data = await parseBody(request)

  const headers: Record<string, string> = {}
  request.headers.forEach((value, key) => {
    headers[key] = value
  })

  return Object.assign(Object.create({ headers }) as object, data) as LarkBridgedRequest
}

const readVerificationToken = (data: Record<string, unknown>): string | undefined => {
  if (data['type'] === 'url_verification' && typeof data['token'] === 'string') {
    return data['token']
  }

  const header = data['header']
  if (header && typeof header === 'object') {
    const token = (header as Record<string, unknown>)['token']
    if (typeof token === 'string') {
      return token
    }
  }

  if (typeof data['token'] === 'string') {
    return data['token']
  }

  return undefined
}

const getRequestValidator = (dispatcher: BridgeDispatcher): RequestValidator | undefined =>
  (dispatcher as BridgeDispatcher & { requestHandle?: RequestValidator }).requestHandle

const verifyWebhookRequest = (
  dispatcher: BridgeDispatcher,
  data: Record<string, unknown>,
): void => {
  const validator = getRequestValidator(dispatcher)
  if (dispatcher.encryptKey) {
    const isValid =
      dispatcher instanceof EventDispatcher
        ? validator?.checkIsEventValidated?.(data)
        : validator?.checkIsCardEventValidated?.(data)
    if (!isValid) {
      throw new Error('Webhook verification failed')
    }
    return
  }

  if (
    dispatcher.verificationToken &&
    readVerificationToken(data) !== dispatcher.verificationToken
  ) {
    throw new Error('Webhook verification failed')
  }
}

/** Follows the SDK's adaptDefault pattern: headers on prototype, body data as own properties. */
const bridgeWebhook = async (request: Request, dispatcher: BridgeDispatcher): Promise<unknown> => {
  const assigned = await buildWebhookRequest(request)
  verifyWebhookRequest(dispatcher, assigned)
  const { isChallenge, challenge } = generateChallenge(assigned, {
    encryptKey: dispatcher.encryptKey,
  })
  if (isChallenge) {
    return challenge
  }

  return dispatcher.invoke(assigned)
}

export { bridgeWebhook, buildWebhookRequest }
