import { describe, expect, it, vi } from 'vitest'
import { EventDispatcher } from '@larksuiteoapi/node-sdk'
import { bridgeWebhook } from '../src/event-bridge.ts'
import { fixtures } from './fixtures.ts'

const { makeChallengeEvent, makeMessageEvent, makeRequest } = fixtures

const createDispatcher = (verificationToken?: string) => new EventDispatcher({ verificationToken })

describe('bridgeWebhook', () => {
  it('forwards a message event to the registered handler', async () => {
    const dispatcher = createDispatcher('test-verification-token')
    const handler = vi.fn()
    dispatcher.register({ 'im.message.receive_v1': handler })

    const req = makeRequest(makeMessageEvent())
    await bridgeWebhook(req, dispatcher)

    expect(handler).toHaveBeenCalledOnce()
  })

  it('handles URL verification challenge', async () => {
    const dispatcher = createDispatcher()
    const req = makeRequest(makeChallengeEvent('abc123'))
    const response = await bridgeWebhook(req, dispatcher)

    expect(response).toBeDefined()
    const str = JSON.stringify(response)
    expect(str).toContain('abc123')
  })

  it('throws on invalid JSON body', async () => {
    const dispatcher = createDispatcher()
    const req = new Request('http://localhost/webhook', {
      body: 'not json{{{',
      method: 'POST',
    })
    await expect(bridgeWebhook(req, dispatcher)).rejects.toThrow(/invalid/i)
  })

  it('rejects mismatched verification tokens', async () => {
    const dispatcher = createDispatcher('expected-token')
    const req = makeRequest(makeMessageEvent())

    await expect(bridgeWebhook(req, dispatcher)).rejects.toThrow(/verification/i)
  })
})
