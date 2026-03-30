import type { LarkWebhookBody } from './types.ts'
import { EventDispatcher, generateChallenge } from '@larksuiteoapi/node-sdk'

const parseBody = async (request: Request): Promise<LarkWebhookBody> => {
  const body = await request.text()
  try {
    return JSON.parse(body) as LarkWebhookBody
  } catch {
    throw new Error('Invalid JSON body')
  }
}

/**
 * Bridges a standard Request to the Lark SDK's EventDispatcher.
 * Follows the SDK's adaptDefault pattern: headers on prototype, body data as own properties.
 * Handles URL verification challenges before forwarding to the dispatcher.
 */
const bridgeWebhook = async (request: Request, dispatcher: EventDispatcher): Promise<unknown> => {
  const data = await parseBody(request)

  const headers: Record<string, string> = {}
  request.headers.forEach((value, key) => {
    headers[key] = value
  })

  const assigned = Object.assign(Object.create({ headers }) as object, data)
  const { isChallenge, challenge } = generateChallenge(assigned, {
    encryptKey: dispatcher.encryptKey,
  })
  if (isChallenge) {
    return challenge
  }

  return dispatcher.invoke(assigned)
}

export default bridgeWebhook
