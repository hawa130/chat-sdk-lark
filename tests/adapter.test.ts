import { HttpResponse, http } from 'msw'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { LoggerLevel, WSClient } from '@larksuiteoapi/node-sdk'
import { LarkAdapter } from '../src/adapter.ts'
import type { LarkRawMessage } from '../src/types.ts'
import { fixtures } from './fixtures.ts'
import { server } from './setup.ts'

const {
  makeCardActionEvent,
  makeChallengeEvent,
  makeDMEvent,
  makeMessageEvent,
  makeModalCloseEvent,
  makeModalResetEvent,
  makeModalSubmitEvent,
  makeReactionEvent,
  makeRequest,
  makeSignedRequest,
  makeSelectActionEvent,
} = fixtures

const BASE = 'https://open.feishu.cn'
const TOKEN_URL = `${BASE}/open-apis/auth/v3/tenant_access_token/internal`

const tokenHandler = http.post(TOKEN_URL, () =>
  HttpResponse.json({ code: 0, expire: 7200, tenant_access_token: 'test-token' }),
)

const botInfoHandler = http.get(`${BASE}/open-apis/bot/v3/info`, () =>
  HttpResponse.json({
    bot: { app_name: 'TestBot', open_id: 'ou_bot001' },
    code: 0,
  }),
)

const createCardHandler = http.post(`${BASE}/open-apis/cardkit/v1/cards`, () =>
  HttpResponse.json({ code: 0, data: { card_id: 'card_test_001' } }),
)

const userInfoHandler = http.get(`${BASE}/open-apis/contact/v3/users/:userId`, () =>
  HttpResponse.json({ code: 0, data: { user: { name: 'Alice' } } }),
)

const makeAdapter = (overrides: Record<string, unknown> = {}) =>
  new LarkAdapter({
    appId: 'test-app-id',
    appSecret: 'test-app-secret',
    verificationToken: 'test-verification-token',
    ...overrides,
  })

const makeMockState = () => ({
  delete: vi.fn().mockResolvedValue(undefined),
  get: vi.fn().mockResolvedValue(null),
  set: vi.fn().mockResolvedValue(undefined),
})

const makeMockChat = () => {
  const mockState = makeMockState()
  return {
    _state: mockState,
    getState: () => mockState,
    getUserName: () => 'TestBot',
    handleIncomingMessage: vi.fn(),
    processAction: vi.fn(),
    processAppHomeOpened: vi.fn(),
    processAssistantContextChanged: vi.fn(),
    processAssistantThreadStarted: vi.fn(),
    processMemberJoinedChannel: vi.fn(),
    processMessage: vi.fn(),
    processModalClose: vi.fn(),
    processModalSubmit: vi.fn(),
    processReaction: vi.fn(),
    processSlashCommand: vi.fn(),
  }
}

const initAdapter = async (adapter: LarkAdapter) => {
  const mockChat = makeMockChat()
  server.use(tokenHandler, botInfoHandler, createCardHandler, userInfoHandler)
  await adapter.initialize(mockChat as never)
  return mockChat
}

const makeRaw = (overrides?: Partial<LarkRawMessage>): LarkRawMessage => ({
  message: {
    chat_id: 'oc_chat001',
    chat_type: 'group',
    content: '{"text":"hello bot"}',
    create_time: '1700000000000',
    message_id: 'om_msg001',
    message_type: 'text',
  },
  sender: {
    sender_id: { open_id: 'ou_user1' },
    sender_type: 'user',
  },
  ...overrides,
})

const makeStreamGen = () => {
  const chunks = ['Hello', ' World', '!']
  return async function* streamChunks() {
    for (const ch of chunks) {
      yield ch
    }
  }
}

type SentMessageRequestBody = {
  content?: string
  msg_type?: 'audio' | 'file' | 'image' | 'interactive' | 'media' | 'text'
  receive_id?: string
}

type EphemeralCardPayload = {
  body?: { elements?: Array<{ content?: string; tag?: string }> }
  schema?: string
}

type EphemeralSendPayload = {
  card?: EphemeralCardPayload
  chat_id?: string
  msg_type?: string
  open_id?: string
}

beforeAll(() => server.listen({ onUnhandledRequest: 'bypass' }))
afterEach(() => {
  server.resetHandlers()
  vi.restoreAllMocks()
})
afterAll(() => server.close())

describe('LarkAdapter', () => {
  describe('websocket incoming', () => {
    it('routes webhook parser SDK logs through the adapter logger', () => {
      const mockLogger = {
        child: () => mockLogger,
        debug: vi.fn(),
        error: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
      }

      makeAdapter({ logger: mockLogger })

      expect(mockLogger.info).toHaveBeenCalledWith('event-dispatch is ready')
    })

    it('starts WS client during initialize when events use ws transport', async () => {
      const startSpy = vi.spyOn(WSClient.prototype, 'start').mockResolvedValue(undefined)
      const adapter = makeAdapter({
        incoming: { callbacks: 'webhook', events: 'ws' },
        ws: { autoReconnect: false, loggerLevel: LoggerLevel.debug },
      })

      await initAdapter(adapter)

      expect(startSpy).toHaveBeenCalledTimes(1)
      expect(startSpy).toHaveBeenCalledWith({
        eventDispatcher: expect.anything(),
      })
    })

    it('passes SDK ws logs through the adapter logger', async () => {
      const mockLogger = {
        child: () => mockLogger,
        debug: vi.fn(),
        error: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
      }
      let wsClient: WSClient | undefined

      vi.spyOn(WSClient.prototype, 'start').mockImplementation(async function (this: WSClient) {
        wsClient = this
      })
      const adapter = makeAdapter({
        incoming: { callbacks: 'webhook', events: 'ws' },
        logger: mockLogger,
      })

      await initAdapter(adapter)

      const sdkLogger = (
        wsClient as unknown as {
          logger?: { logger?: { info: (message: unknown) => void } }
        }
      )?.logger?.logger

      sdkLogger?.info(['[ws]', 'ws client ready'])

      expect(mockLogger.info).toHaveBeenCalledWith('ws client ready')
    })

    it('closes WS client during disconnect when ws transport is enabled', async () => {
      vi.spyOn(WSClient.prototype, 'start').mockResolvedValue(undefined)
      const closeSpy = vi.spyOn(WSClient.prototype, 'close').mockImplementation(() => undefined)
      const adapter = makeAdapter({
        incoming: { callbacks: 'webhook', events: 'ws' },
      })

      await initAdapter(adapter)
      await adapter.disconnect()

      expect(closeSpy).toHaveBeenCalledTimes(1)
    })

    it('retries WS startup on reinitialize when no socket connection was established', async () => {
      const startSpy = vi.spyOn(WSClient.prototype, 'start').mockResolvedValue(undefined)
      const closeSpy = vi.spyOn(WSClient.prototype, 'close').mockImplementation(() => undefined)
      const adapter = makeAdapter({
        incoming: { callbacks: 'webhook', events: 'ws' },
      })
      const mockChat = makeMockChat()
      server.use(tokenHandler, botInfoHandler, createCardHandler, userInfoHandler)

      await adapter.initialize(mockChat as never)
      await adapter.initialize(mockChat as never)

      expect(startSpy).toHaveBeenCalledTimes(2)
      expect(closeSpy).toHaveBeenCalledTimes(1)
    })

    it('routes ws message events to processMessage', async () => {
      let dispatcher: { invoke: (data: Record<string, unknown>) => Promise<unknown> } | undefined
      vi.spyOn(WSClient.prototype, 'start').mockImplementation(async ({ eventDispatcher }) => {
        dispatcher = eventDispatcher as typeof dispatcher
      })
      const adapter = makeAdapter({
        incoming: { callbacks: 'webhook', events: 'ws' },
      })
      const mockChat = await initAdapter(adapter)

      await dispatcher?.invoke(makeMessageEvent() as Record<string, unknown>)

      expect(mockChat.processMessage).toHaveBeenCalledTimes(1)
    })

    it('routes ws card callbacks to processAction', async () => {
      let dispatcher: { invoke: (data: Record<string, unknown>) => Promise<unknown> } | undefined
      vi.spyOn(WSClient.prototype, 'start').mockImplementation(async ({ eventDispatcher }) => {
        dispatcher = eventDispatcher as typeof dispatcher
      })
      const adapter = makeAdapter({
        incoming: { callbacks: 'ws', events: 'webhook' },
      })
      const mockChat = await initAdapter(adapter)
      server.use(
        http.get(`${BASE}/open-apis/im/v1/messages/:message_id`, () =>
          HttpResponse.json({
            code: 0,
            data: {
              items: [
                {
                  chat_id: 'oc_chat001',
                  message_id: 'om_card_msg001',
                  root_id: 'om_root001',
                  thread_id: 'omt_thread001',
                },
              ],
            },
          }),
        ),
      )

      await dispatcher?.invoke(
        makeCardActionEvent('approve', 'order_123') as Record<string, unknown>,
      )

      await vi.waitFor(() => {
        expect(mockChat.processAction).toHaveBeenCalledTimes(1)
      })
    })
  })

  describe('thread ID encoding', () => {
    it('encodes chatId only', () => {
      const adapter = makeAdapter()
      const threadId = adapter.encodeThreadId({ chatId: 'oc_chat001' })
      expect(threadId).toMatch(/^lark:/)
      expect(threadId.split(':')).toHaveLength(2)
    })

    it('encodes chatId + threadId', () => {
      const adapter = makeAdapter()
      const threadId = adapter.encodeThreadId({
        chatId: 'oc_chat001',
        threadId: 'omt_thread001',
      })
      expect(threadId.split(':')).toHaveLength(3)
    })

    it('decode round-trips with chatId only', () => {
      const adapter = makeAdapter()
      const original = { chatId: 'oc_chat001' }
      const threadId = adapter.encodeThreadId(original)
      const decoded = adapter.decodeThreadId(threadId)
      expect(decoded.chatId).toBe('oc_chat001')
      expect(decoded.threadId).toBeUndefined()
    })

    it('decode round-trips with chatId + threadId', () => {
      const adapter = makeAdapter()
      const original = { chatId: 'oc_chat001', threadId: 'omt_thread001' }
      const threadId = adapter.encodeThreadId(original)
      expect(adapter.decodeThreadId(threadId)).toEqual(original)
    })

    it('handles special characters in chatId', () => {
      const adapter = makeAdapter()
      const original = { chatId: 'oc_chat!@#$%^&*()' }
      const threadId = adapter.encodeThreadId(original)
      expect(adapter.decodeThreadId(threadId).chatId).toBe(original.chatId)
    })

    it('throws on invalid prefix', () => {
      const adapter = makeAdapter()
      expect(() => adapter.decodeThreadId('slack:abc')).toThrow(/prefix/)
    })

    it('throws on missing segments', () => {
      const adapter = makeAdapter()
      expect(() => adapter.decodeThreadId('lark:')).toThrow()
    })

    it('channelIdFromThreadId extracts chatId', () => {
      const adapter = makeAdapter()
      const threadId = adapter.encodeThreadId({ chatId: 'oc_chat001' })
      expect(adapter.channelIdFromThreadId(threadId)).toBe('oc_chat001')
    })
  })

  describe('handleWebhook', () => {
    it('handles URL verification challenge', async () => {
      const adapter = makeAdapter()
      await initAdapter(adapter)

      const req = makeRequest(makeChallengeEvent('test-abc'))
      const res = await adapter.handleWebhook(req)

      expect(res.status).toBe(200)
      const json = (await res.json()) as Record<string, unknown>
      expect(JSON.stringify(json)).toContain('test-abc')
    })

    it('returns 400 for invalid JSON', async () => {
      const adapter = makeAdapter()
      await initAdapter(adapter)

      const req = new Request('http://localhost/webhook', {
        body: 'not json{{{',
        headers: { 'content-type': 'application/json' },
        method: 'POST',
      })
      expect((await adapter.handleWebhook(req)).status).toBe(400)
    })

    it('returns 200 immediately for normal events', async () => {
      const adapter = makeAdapter()
      await initAdapter(adapter)

      const req = makeRequest(makeMessageEvent())
      expect((await adapter.handleWebhook(req)).status).toBe(200)
    })

    it('routes signed events through bridgeWebhook when Encrypt Key is configured', async () => {
      const adapter = makeAdapter({ encryptKey: 'test-encrypt-key' })
      const mockChat = await initAdapter(adapter)

      const res = await adapter.handleWebhook(
        makeSignedRequest(makeMessageEvent(), 'test-encrypt-key'),
      )

      expect(res.status).toBe(200)
      expect(mockChat.processMessage).toHaveBeenCalledTimes(1)
    })

    it('rejects invalid webhook verification', async () => {
      const adapter = makeAdapter({ encryptKey: 'test-encrypt-key' })
      const mockChat = await initAdapter(adapter)

      const res = await adapter.handleWebhook(makeRequest(makeMessageEvent()))

      expect(res.status).toBe(403)
      expect(mockChat.processMessage).not.toHaveBeenCalled()
    })

    it('routes message event to processMessage with factory', async () => {
      const adapter = makeAdapter()
      const mockChat = await initAdapter(adapter)

      await adapter.handleWebhook(makeRequest(makeMessageEvent()))
      expect(mockChat.processMessage).toHaveBeenCalledTimes(1)

      const call = mockChat.processMessage.mock.calls[0]!
      expect(call[0]).toBe(adapter)
      expect(call[1]).toMatch(/^lark:/)
      expect(typeof call[2]).toBe('function')

      // Execute factory to get message
      const message = await (call[2] as () => Promise<unknown>)()
      expect((message as { text: string }).text).toContain('hello bot')
    })

    it('does not route message webhooks when events use ws transport', async () => {
      const adapter = makeAdapter({
        incoming: { callbacks: 'webhook', events: 'ws' },
      })
      const mockChat = await initAdapter(adapter)

      const res = await adapter.handleWebhook(makeRequest(makeMessageEvent()))

      expect(res.status).toBe(200)
      expect(mockChat.processMessage).not.toHaveBeenCalled()
    })

    it('extracts thread_id from message events', async () => {
      const adapter = makeAdapter()
      const mockChat = await initAdapter(adapter)

      await adapter.handleWebhook(
        makeRequest(
          makeMessageEvent({
            event: {
              message: {
                chat_id: 'oc_chat001',
                chat_type: 'group',
                content: '{"text":"threaded"}',
                create_time: '1700000000000',
                message_id: 'om_msg_thread',
                message_type: 'text',
                root_id: 'om_root001',
                thread_id: 'omt_thread001',
              },
              sender: {
                sender_id: { open_id: 'ou_user1' },
                sender_type: 'user',
              },
            },
          }),
        ),
      )

      const factory = mockChat.processMessage.mock.calls[0]![2]
      const message = (await (
        factory as () => Promise<{
          threadId: string
        }>
      )()) as { threadId: string }
      expect(adapter.decodeThreadId(message.threadId).threadId).toBe('omt_thread001')
    })

    it('routes reaction event to processReaction', async () => {
      const adapter = makeAdapter()
      const mockChat = await initAdapter(adapter)

      server.use(
        http.get(`${BASE}/open-apis/im/v1/messages/:message_id`, () =>
          HttpResponse.json({
            code: 0,
            data: {
              items: [
                {
                  chat_id: 'oc_chat001',
                  message_id: 'om_msg001',
                  root_id: 'om_root001',
                  thread_id: 'omt_thread001',
                },
              ],
            },
          }),
        ),
      )

      const event = makeReactionEvent('created')
      const promises: Array<Promise<unknown>> = []
      const options = {
        waitUntil: (task: Promise<unknown>) => {
          promises.push(task)
        },
      }

      const res = await adapter.handleWebhook(makeRequest(event), options)
      expect(res.status).toBe(200)
      await Promise.allSettled(promises)
      // Wait for async threadId + user resolution
      await vi.waitFor(() => {
        expect(mockChat.processReaction).toHaveBeenCalledTimes(1)
      })
      const call = mockChat.processReaction.mock.calls[0]!
      const reactionEvent = call[0] as {
        threadId: string
        messageId: string
        rawEmoji: string
        user: { fullName: string; userName: string }
      }
      expect(reactionEvent.threadId).toContain('lark:')
      expect(reactionEvent.messageId).toBe('om_msg001')
      expect(reactionEvent.rawEmoji).toBe('THUMBSUP')
      expect(reactionEvent.user.fullName).toBe('Alice')
      expect(reactionEvent.user.userName).toBe('Alice')
      // Verify threadId decodes back to the chat from getMessage
      expect(adapter.channelIdFromThreadId(reactionEvent.threadId)).toBe('oc_chat001')
      expect(adapter.decodeThreadId(reactionEvent.threadId).threadId).toBe('omt_thread001')
    })

    it('routes card.action.trigger to processAction', async () => {
      const adapter = makeAdapter()
      const mockChat = await initAdapter(adapter)
      server.use(
        http.get(`${BASE}/open-apis/im/v1/messages/:message_id`, () =>
          HttpResponse.json({
            code: 0,
            data: {
              items: [
                {
                  chat_id: 'oc_chat001',
                  message_id: 'om_card_msg001',
                  root_id: 'om_root001',
                  thread_id: 'omt_thread001',
                },
              ],
            },
          }),
        ),
      )

      const event = makeCardActionEvent('approve', 'order_123')
      const res = await adapter.handleWebhook(makeRequest(event))
      expect(res.status).toBe(200)
      expect(await res.json()).toEqual({})
      await vi.waitFor(() => {
        expect(mockChat.processAction).toHaveBeenCalledTimes(1)
      })

      const call = mockChat.processAction.mock.calls[0]!
      const actionEvent = call[0] as {
        actionId: string
        messageId: string
        threadId: string
        triggerId: string
        user: { userId: string }
        value: string
      }
      expect(actionEvent.actionId).toBe('approve')
      expect(actionEvent.value).toBe('order_123')
      expect(actionEvent.messageId).toBe('om_card_msg001')
      expect(adapter.channelIdFromThreadId(actionEvent.threadId)).toBe('oc_chat001')
      expect(adapter.decodeThreadId(actionEvent.threadId).threadId).toBe('omt_thread001')
      expect(actionEvent.triggerId).toBe('oc_chat001:om_card_msg001')
      expect(actionEvent.user.userId).toBe('ou_user1')
    })

    it('does not route card webhooks when callbacks use ws transport', async () => {
      const adapter = makeAdapter({
        incoming: { callbacks: 'ws', events: 'webhook' },
      })
      const mockChat = await initAdapter(adapter)

      const res = await adapter.handleWebhook(
        makeRequest(makeCardActionEvent('approve', 'order_123')),
      )

      expect(res.status).toBe(200)
      expect(mockChat.processAction).not.toHaveBeenCalled()
    })

    it('rejects card.action.trigger when verification token does not match', async () => {
      const adapter = makeAdapter()
      const mockChat = await initAdapter(adapter)

      const event = makeCardActionEvent('approve', 'order_123')
      event.header.token = 'wrong-token'

      const res = await adapter.handleWebhook(makeRequest(event))

      expect(res.status).toBe(403)
      expect(mockChat.processAction).not.toHaveBeenCalled()
    })

    it('routes select action with option as value', async () => {
      const adapter = makeAdapter()
      const mockChat = await initAdapter(adapter)
      server.use(
        http.get(`${BASE}/open-apis/im/v1/messages/:message_id`, () =>
          HttpResponse.json({
            code: 0,
            data: { items: [{ chat_id: 'oc_chat001', message_id: 'om_card_msg002' }] },
          }),
        ),
      )

      const event = makeSelectActionEvent('priority', 'high')
      await adapter.handleWebhook(makeRequest(event))
      await vi.waitFor(() => {
        expect(mockChat.processAction).toHaveBeenCalledTimes(1)
      })

      const call = mockChat.processAction.mock.calls[0]!
      const actionEvent = call[0] as { actionId: string; value: string }
      expect(actionEvent.actionId).toBe('priority')
      expect(actionEvent.value).toBe('high')
    })

    it('routes modal form submit to processModalSubmit', async () => {
      const adapter = makeAdapter()
      const mockChat = await initAdapter(adapter)
      mockChat.processModalSubmit.mockResolvedValue(undefined)
      const waitUntil = vi.fn()
      server.use(
        http.get(`${BASE}/open-apis/im/v1/messages/:message_id`, () =>
          HttpResponse.json({
            code: 0,
            data: { items: [{ chat_id: 'oc_chat001', message_id: 'om_form_msg001' }] },
          }),
        ),
      )

      const event = makeModalSubmitEvent(
        'feedback_form',
        { message: 'Great!' },
        'ctx_1',
        '{"k":"v"}',
      )
      await adapter.handleWebhook(makeRequest(event), { waitUntil })

      // processModalSubmit is called async — wait a tick
      await new Promise((r) => setTimeout(r, 0))
      expect(mockChat.processModalSubmit).toHaveBeenCalledTimes(1)
      expect(waitUntil).toHaveBeenCalledTimes(2)

      const call = mockChat.processModalSubmit.mock.calls[0]!
      const submitEvent = call[0] as {
        callbackId: string
        privateMetadata: string
        values: Record<string, string>
        viewId: string
      }
      expect(submitEvent.callbackId).toBe('feedback_form')
      expect(submitEvent.values).toEqual({ message: 'Great!' })
      expect(submitEvent.privateMetadata).toBe('{"k":"v"}')
      expect(submitEvent.viewId).toBe('om_form_msg001')
      // contextId is the second argument
      expect(call[1]).toBe('ctx_1')
    })

    it('ignores modal form reset callbacks for lark fallback modals', async () => {
      const adapter = makeAdapter()
      const mockChat = await initAdapter(adapter)

      const event = makeModalResetEvent('feedback_form')
      await adapter.handleWebhook(makeRequest(event))

      expect(mockChat.processModalClose).not.toHaveBeenCalled()
    })

    it('routes modal fallback close callbacks to processModalClose', async () => {
      const adapter = makeAdapter()
      const mockChat = await initAdapter(adapter)
      mockChat.processModalClose.mockResolvedValue(undefined)
      const waitUntil = vi.fn()
      let patchedContent: unknown = undefined
      server.use(
        http.get(`${BASE}/open-apis/im/v1/messages/:message_id`, () =>
          HttpResponse.json({
            code: 0,
            data: { items: [{ chat_id: 'oc_chat001', message_id: 'om_form_msg001' }] },
          }),
        ),
        http.patch(`${BASE}/open-apis/im/v1/messages/:message_id`, async ({ request }) => {
          patchedContent = await request.json()
          return HttpResponse.json({ code: 0 })
        }),
      )

      const event = makeModalCloseEvent('feedback_form', 'ctx_1', '{"k":"v"}', true, 'Feedback')
      await adapter.handleWebhook(makeRequest(event), { waitUntil })

      await new Promise((r) => setTimeout(r, 0))
      expect(mockChat.processModalClose).toHaveBeenCalledTimes(1)
      expect(waitUntil).toHaveBeenCalledTimes(1)

      const call = mockChat.processModalClose.mock.calls[0]!
      const closeEvent = call[0] as {
        callbackId: string
        privateMetadata: string
        viewId: string
      }
      expect(closeEvent.callbackId).toBe('feedback_form')
      expect(closeEvent.privateMetadata).toBe('{"k":"v"}')
      expect(closeEvent.viewId).toBe('om_form_msg001')
      expect(call[1]).toBe('ctx_1')
      expect(patchedContent).toMatchObject({
        content: expect.stringContaining('Form closed.'),
      })
    })

    it('closes fallback modals without dispatching processModalClose when notifyOnClose is false', async () => {
      const adapter = makeAdapter()
      const mockChat = await initAdapter(adapter)
      const waitUntil = vi.fn()
      let patchedContent: unknown = undefined
      server.use(
        http.get(`${BASE}/open-apis/im/v1/messages/:message_id`, () =>
          HttpResponse.json({
            code: 0,
            data: { items: [{ chat_id: 'oc_chat001', message_id: 'om_form_msg001' }] },
          }),
        ),
        http.patch(`${BASE}/open-apis/im/v1/messages/:message_id`, async ({ request }) => {
          patchedContent = await request.json()
          return HttpResponse.json({ code: 0 })
        }),
      )

      const event = makeModalCloseEvent('feedback_form', 'ctx_1', '{"k":"v"}', false, 'Feedback')
      await adapter.handleWebhook(makeRequest(event), { waitUntil })

      await new Promise((r) => setTimeout(r, 0))
      expect(mockChat.processModalClose).not.toHaveBeenCalled()
      expect(waitUntil).toHaveBeenCalledTimes(1)
      expect(patchedContent).toMatchObject({
        content: expect.stringContaining('Form closed.'),
      })
    })
  })

  describe('openModal', () => {
    it('sends a form card and returns viewId', async () => {
      const adapter = makeAdapter()
      await initAdapter(adapter)

      server.use(
        http.post(`${BASE}/open-apis/im/v1/messages`, () =>
          HttpResponse.json({ code: 0, data: { message_id: 'om_modal001' } }),
        ),
      )

      const modal = {
        callbackId: 'fb_form',
        children: [{ id: 'msg', label: 'Message', type: 'text_input' as const }],
        submitLabel: 'Send',
        title: 'Feedback',
        type: 'modal' as const,
      }

      const result = await adapter.openModal('oc_chat001:om_trigger', modal, 'ctx_1')
      expect(result.viewId).toBe('om_modal001')
    })
  })

  describe('parseMessage', () => {
    let adapter: LarkAdapter = undefined!

    beforeEach(async () => {
      adapter = makeAdapter()
      await initAdapter(adapter)
    })

    it('parses a text message', () => {
      const msg = adapter.parseMessage(makeRaw())
      expect(msg.id).toBe('om_msg001')
      expect(msg.text).toBe('hello bot')
      expect(msg.author.userId).toBe('ou_user1')
      expect(msg.author.isBot).toBe(false)
      expect(msg.author.isMe).toBe(false)
    })

    it('replaces mention placeholders', () => {
      const raw = makeRaw({
        message: {
          chat_id: 'oc_chat001',
          chat_type: 'group',
          content: '{"text":"@_user_1 hello"}',
          create_time: '1700000000000',
          mentions: [{ id: { open_id: 'ou_bot001' }, key: '@_user_1', name: 'TestBot' }],
          message_id: 'om_msg002',
          message_type: 'text',
        },
      })
      const msg = adapter.parseMessage(raw)
      expect(msg.text).toContain('@TestBot')
      expect(msg.text).not.toContain('@_user_1')
    })

    it('sets isMention for DMs', () => {
      const raw = makeRaw({
        message: {
          chat_id: 'oc_dm001',
          chat_type: 'p2p',
          content: '{"text":"hello"}',
          create_time: '1700000000000',
          message_id: 'om_dm001',
          message_type: 'text',
        },
      })
      expect(adapter.parseMessage(raw).isMention).toBe(true)
    })

    it('detects bot mention in group', () => {
      const raw = makeRaw({
        message: {
          chat_id: 'oc_chat001',
          chat_type: 'group',
          content: '{"text":"@_user_1 hello"}',
          create_time: '1700000000000',
          mentions: [{ id: { open_id: 'ou_bot001' }, key: '@_user_1', name: 'TestBot' }],
          message_id: 'om_msg003',
          message_type: 'text',
        },
      })
      expect(adapter.parseMessage(raw).isMention).toBe(true)
    })

    it('identifies bot messages', () => {
      const raw = makeRaw({
        message: {
          chat_id: 'oc_chat001',
          chat_type: 'group',
          content: '{"text":"I am a bot"}',
          create_time: '1700000000000',
          message_id: 'om_msg004',
          message_type: 'text',
        },
        sender: { sender_id: { open_id: 'ou_bot001' }, sender_type: 'bot' },
      })
      const msg = adapter.parseMessage(raw)
      expect(msg.author.isBot).toBe(true)
      expect(msg.author.isMe).toBe(true)
    })

    it('includes metadata with dateSent', () => {
      const msg = adapter.parseMessage(makeRaw())
      expect(msg.metadata.dateSent).toBeInstanceOf(Date)
      expect(msg.metadata.edited).toBe(false)
    })

    it('detects edited messages from update_time', () => {
      const raw = makeRaw({
        message: {
          chat_id: 'oc_chat001',
          chat_type: 'group',
          content: '{"text":"edited"}',
          create_time: '1700000000000',
          message_id: 'om_msg005',
          message_type: 'text',
          update_time: '1700000001000',
        },
      })
      expect(adapter.parseMessage(raw).metadata.edited).toBe(true)
    })

    it('edited is false when update_time equals create_time', () => {
      const raw = makeRaw({
        message: {
          chat_id: 'oc_chat001',
          chat_type: 'group',
          content: '{"text":"not edited"}',
          create_time: '1700000000000',
          message_id: 'om_msg006',
          message_type: 'text',
          update_time: '1700000000000',
        },
      })
      expect(adapter.parseMessage(raw).metadata.edited).toBe(false)
    })

    it('parses post rich text format', () => {
      const raw = makeRaw({
        message: {
          chat_id: 'oc_chat001',
          chat_type: 'group',
          content: JSON.stringify({
            post: {
              zh_cn: {
                content: [
                  [
                    { tag: 'text', text: 'Hello' },
                    { tag: 'a', href: 'https://example.com', text: 'link' },
                  ],
                ],
                title: 'Title',
              },
            },
          }),
          create_time: '1700000000000',
          message_id: 'om_msg007',
          message_type: 'post',
        },
      })
      const message = adapter.parseMessage(raw)
      expect(message.text).toContain('Hello')
      expect(message.text).toContain('link')
    })

    it('handles empty content gracefully', () => {
      const raw = makeRaw({
        message: {
          chat_id: 'oc_chat001',
          chat_type: 'group',
          content: '',
          create_time: '1700000000000',
          message_id: 'om_msg008',
          message_type: 'text',
        },
      })
      expect(() => adapter.parseMessage(raw)).not.toThrow()
      expect(adapter.parseMessage(raw).text).toBe('')
    })

    it('handles missing mentions array', () => {
      const raw = makeRaw({
        message: {
          chat_id: 'oc_chat001',
          chat_type: 'group',
          content: '{"text":"no mentions here"}',
          create_time: '1700000000000',
          message_id: 'om_msg009',
          message_type: 'text',
        },
      })
      expect(() => adapter.parseMessage(raw)).not.toThrow()
      expect(adapter.parseMessage(raw).text).toBe('no mentions here')
    })

    it('parses image message with attachment', () => {
      const raw = makeRaw({
        message: {
          ...makeRaw().message,
          content: '{"image_key":"img_test_001"}',
          message_type: 'image',
        },
      })
      const message = adapter.parseMessage(raw)
      expect(message.attachments).toHaveLength(1)
      expect(message.attachments[0]!.type).toBe('image')
      expect(message.attachments[0]!.fetchData).toBeTypeOf('function')
      expect(message.text).toBe('')
    })

    it('parses file message with attachment', () => {
      const raw = makeRaw({
        message: {
          ...makeRaw().message,
          content: '{"file_key":"file_test_001","file_name":"report.pdf"}',
          message_type: 'file',
        },
      })
      const message = adapter.parseMessage(raw)
      expect(message.attachments).toHaveLength(1)
      expect(message.attachments[0]!.type).toBe('file')
      expect(message.attachments[0]!.name).toBe('report.pdf')
      expect(message.attachments[0]!.fetchData).toBeTypeOf('function')
      expect(message.text).toBe('')
    })

    it('parses audio message with attachment', () => {
      const raw = makeRaw({
        message: {
          ...makeRaw().message,
          content: '{"file_key":"file_audio_001","duration":5000}',
          message_type: 'audio',
        },
      })
      const message = adapter.parseMessage(raw)
      expect(message.attachments).toHaveLength(1)
      expect(message.attachments[0]!.type).toBe('audio')
      expect(message.attachments[0]!.fetchData).toBeTypeOf('function')
      expect(message.text).toBe('')
    })

    it('parses media (video) message with attachment', () => {
      const raw = makeRaw({
        message: {
          ...makeRaw().message,
          content:
            '{"file_key":"file_video_001","image_key":"img_thumb_001","file_name":"demo.mp4","duration":10000}',
          message_type: 'media',
        },
      })
      const message = adapter.parseMessage(raw)
      expect(message.attachments).toHaveLength(1)
      expect(message.attachments[0]!.type).toBe('video')
      expect(message.attachments[0]!.name).toBe('demo.mp4')
      expect(message.attachments[0]!.fetchData).toBeTypeOf('function')
      expect(message.text).toBe('')
    })

    it('returns empty attachments for text messages', () => {
      const message = adapter.parseMessage(makeRaw())
      expect(message.attachments).toHaveLength(0)
      expect(message.text).toBe('hello bot')
    })
  })

  describe('message sending', () => {
    let adapter: LarkAdapter = undefined!

    beforeEach(async () => {
      adapter = makeAdapter()
      await initAdapter(adapter)
    })

    it('postMessage sends text to chat', async () => {
      let captured: unknown = undefined
      server.use(
        tokenHandler,
        http.post(`${BASE}/open-apis/im/v1/messages`, async ({ request }) => {
          captured = await request.json()
          return HttpResponse.json({
            code: 0,
            data: { message_id: 'om_sent1', thread_id: 'omt_thread001' },
          })
        }),
      )
      const threadId = adapter.encodeThreadId({ chatId: 'oc_chat001' })
      const result = await adapter.postMessage(threadId, 'hello')
      expect(captured).toMatchObject({ msg_type: 'text', receive_id: 'oc_chat001' })
      expect(result.id).toBe('om_sent1')
      expect(adapter.decodeThreadId(result.threadId).threadId).toBe('omt_thread001')
    })

    it('postMessage replies within a thread when threadId is present', async () => {
      let replyTo: unknown = undefined
      let replyBody: unknown = undefined
      server.use(
        tokenHandler,
        http.get(`${BASE}/open-apis/im/v1/messages`, ({ request }) => {
          const url = new URL(request.url)
          if (url.searchParams.get('container_id_type') !== 'thread') {
            return HttpResponse.json({ code: 0, data: { has_more: false, items: [] } })
          }
          return HttpResponse.json({
            code: 0,
            data: {
              has_more: false,
              items: [
                {
                  chat_id: 'oc_chat001',
                  message_id: 'om_root1',
                  root_id: '',
                  thread_id: 'omt_thread001',
                },
              ],
            },
          })
        }),
        http.post(`${BASE}/open-apis/im/v1/messages/:id/reply`, async ({ params, request }) => {
          replyTo = params['id']
          replyBody = await request.json()
          return HttpResponse.json({
            code: 0,
            data: { message_id: 'om_reply1', root_id: 'om_root1', thread_id: 'omt_thread001' },
          })
        }),
      )
      const threadId = adapter.encodeThreadId({ chatId: 'oc_chat001', threadId: 'omt_thread001' })
      const result = await adapter.postMessage(threadId, 'reply text')
      expect(replyTo).toBe('om_root1')
      expect(replyBody).toMatchObject({ reply_in_thread: true })
      expect(adapter.decodeThreadId(result.threadId).threadId).toBe('omt_thread001')
    })

    it('postMessage with files and text returns the text message id', async () => {
      const sentBodies: SentMessageRequestBody[] = []
      server.use(
        tokenHandler,
        http.post(`${BASE}/open-apis/im/v1/files`, () =>
          HttpResponse.json({ code: 0, data: { file_key: 'file_test_001' } }),
        ),
        http.post(`${BASE}/open-apis/im/v1/messages`, async ({ request }) => {
          const body = (await request.json()) as SentMessageRequestBody
          sentBodies.push(body)
          if (body.msg_type === 'file') {
            return HttpResponse.json({ code: 0, data: { message_id: 'om_file1' } })
          }
          return HttpResponse.json({
            code: 0,
            data: { message_id: 'om_text1', thread_id: 'omt_thread001' },
          })
        }),
      )

      const threadId = adapter.encodeThreadId({ chatId: 'oc_chat001' })
      const result = await adapter.postMessage(threadId, {
        files: [
          {
            data: Buffer.from('pdf-bytes'),
            filename: 'report.pdf',
            mimeType: 'application/pdf',
          },
        ],
        raw: 'hello with file',
      })

      expect(sentBodies).toHaveLength(2)
      expect(sentBodies[0]).toMatchObject({ msg_type: 'file', receive_id: 'oc_chat001' })
      expect(sentBodies[1]).toMatchObject({ msg_type: 'text', receive_id: 'oc_chat001' })
      expect(result.id).toBe('om_text1')
      expect(adapter.decodeThreadId(result.threadId).threadId).toBe('omt_thread001')
    })

    it('postMessage with files only skips empty text sends', async () => {
      const sentBodies: SentMessageRequestBody[] = []
      server.use(
        tokenHandler,
        http.post(`${BASE}/open-apis/im/v1/files`, () =>
          HttpResponse.json({ code: 0, data: { file_key: 'file_test_001' } }),
        ),
        http.post(`${BASE}/open-apis/im/v1/messages`, async ({ request }) => {
          const body = (await request.json()) as SentMessageRequestBody
          sentBodies.push(body)
          return HttpResponse.json({ code: 0, data: { message_id: 'om_file_only' } })
        }),
      )

      const threadId = adapter.encodeThreadId({ chatId: 'oc_chat001' })
      const result = await adapter.postMessage(threadId, {
        files: [
          {
            data: Buffer.from('pdf-bytes'),
            filename: 'report.pdf',
            mimeType: 'application/pdf',
          },
        ],
        raw: '   ',
      })

      expect(sentBodies).toHaveLength(1)
      expect(sentBodies[0]).toMatchObject({ msg_type: 'file', receive_id: 'oc_chat001' })
      expect(result.id).toBe('om_file_only')
    })

    it('postMessage with audio file uploads opus and sends audio message', async () => {
      const sentBodies: SentMessageRequestBody[] = []
      let uploadedType: string | null = null
      server.use(
        tokenHandler,
        http.post(`${BASE}/open-apis/im/v1/files`, async ({ request }) => {
          const body = await request.formData()
          uploadedType = String(body.get('file_type'))
          return HttpResponse.json({ code: 0, data: { file_key: 'file_audio_001' } })
        }),
        http.post(`${BASE}/open-apis/im/v1/messages`, async ({ request }) => {
          const body = (await request.json()) as SentMessageRequestBody
          sentBodies.push(body)
          return HttpResponse.json({ code: 0, data: { message_id: 'om_audio1' } })
        }),
      )

      const threadId = adapter.encodeThreadId({ chatId: 'oc_chat001' })
      const result = await adapter.postMessage(threadId, {
        files: [
          {
            data: Buffer.from('audio-bytes'),
            filename: 'voice.opus',
            mimeType: 'audio/opus',
          },
        ],
        raw: '   ',
      })

      expect(uploadedType).toBe('opus')
      expect(sentBodies).toHaveLength(1)
      const audioBody = sentBodies[0]
      expect(audioBody).toBeDefined()
      if (!audioBody) {
        throw new Error('Expected uploaded audio message payload')
      }
      expect(audioBody).toMatchObject({ msg_type: 'audio', receive_id: 'oc_chat001' })
      expect(JSON.parse(audioBody.content ?? '{}')).toEqual({ file_key: 'file_audio_001' })
      expect(result.id).toBe('om_audio1')
    })

    it('postMessage with mp4 uploads mp4 and sends media message', async () => {
      const sentBodies: SentMessageRequestBody[] = []
      let uploadedType: string | null = null
      server.use(
        tokenHandler,
        http.post(`${BASE}/open-apis/im/v1/files`, async ({ request }) => {
          const body = await request.formData()
          uploadedType = String(body.get('file_type'))
          return HttpResponse.json({ code: 0, data: { file_key: 'file_video_001' } })
        }),
        http.post(`${BASE}/open-apis/im/v1/messages`, async ({ request }) => {
          const body = (await request.json()) as SentMessageRequestBody
          sentBodies.push(body)
          return HttpResponse.json({ code: 0, data: { message_id: 'om_video1' } })
        }),
      )

      const threadId = adapter.encodeThreadId({ chatId: 'oc_chat001' })
      const result = await adapter.postMessage(threadId, {
        files: [
          {
            data: Buffer.from('video-bytes'),
            filename: 'demo.mp4',
            mimeType: 'video/mp4',
          },
        ],
        raw: '',
      })

      expect(uploadedType).toBe('mp4')
      expect(sentBodies).toHaveLength(1)
      const videoBody = sentBodies[0]
      expect(videoBody).toBeDefined()
      if (!videoBody) {
        throw new Error('Expected uploaded video message payload')
      }
      expect(videoBody).toMatchObject({ msg_type: 'media', receive_id: 'oc_chat001' })
      expect(JSON.parse(videoBody.content ?? '{}')).toEqual({ file_key: 'file_video_001' })
      expect(result.id).toBe('om_video1')
    })

    it('editMessage calls updateMessage', async () => {
      let editedId: unknown = undefined
      server.use(
        tokenHandler,
        http.put(`${BASE}/open-apis/im/v1/messages/:id`, ({ params }) => {
          editedId = params['id']
          return HttpResponse.json({ code: 0 })
        }),
      )
      const threadId = adapter.encodeThreadId({ chatId: 'oc_chat001' })
      await adapter.editMessage(threadId, 'om_edit1', 'updated text')
      expect(editedId).toBe('om_edit1')
    })

    it('editMessage with card uses PATCH endpoint', async () => {
      let patchedId: unknown = undefined
      let patchBody: unknown = undefined
      server.use(
        tokenHandler,
        createCardHandler,
        http.patch(`${BASE}/open-apis/im/v1/messages/:id`, async ({ params, request }) => {
          patchedId = params['id']
          patchBody = await request.json()
          return HttpResponse.json({ code: 0 })
        }),
      )
      const card = { children: [], title: 'Updated Card', type: 'card' as const }
      const threadId = adapter.encodeThreadId({ chatId: 'oc_chat001' })
      await adapter.editMessage(threadId, 'om_edit_card', card)
      expect(patchedId).toBe('om_edit_card')
      expect(patchBody).toMatchObject({ content: expect.any(String) })
    })

    it('editMessage with PostableCard uses PATCH endpoint', async () => {
      let patchedId: unknown = undefined
      server.use(
        tokenHandler,
        createCardHandler,
        http.patch(`${BASE}/open-apis/im/v1/messages/:id`, async ({ params }) => {
          patchedId = params['id']
          return HttpResponse.json({ code: 0 })
        }),
      )
      const message = { card: { children: [], title: 'Wrapped', type: 'card' as const } }
      const threadId = adapter.encodeThreadId({ chatId: 'oc_chat001' })
      await adapter.editMessage(threadId, 'om_edit_pc', message)
      expect(patchedId).toBe('om_edit_pc')
    })

    it('deleteMessage calls delete API', async () => {
      let deletedId: unknown = undefined
      server.use(
        tokenHandler,
        http.delete(`${BASE}/open-apis/im/v1/messages/:id`, ({ params }) => {
          deletedId = params['id']
          return HttpResponse.json({ code: 0 })
        }),
      )
      const threadId = adapter.encodeThreadId({ chatId: 'oc_chat001' })
      await adapter.deleteMessage(threadId, 'om_del1')
      expect(deletedId).toBe('om_del1')
    })

    it('postMessage with card sends via card_id', async () => {
      let captured: unknown = undefined
      server.use(
        tokenHandler,
        createCardHandler,
        http.post(`${BASE}/open-apis/im/v1/messages`, async ({ request }) => {
          captured = await request.json()
          return HttpResponse.json({ code: 0, data: { message_id: 'om_card1' } })
        }),
      )
      const card = {
        children: [],
        title: 'Test Card',
        type: 'card' as const,
      }
      const threadId = adapter.encodeThreadId({ chatId: 'oc_chat001' })
      const result = await adapter.postMessage(threadId, card)
      expect(captured).toMatchObject({ msg_type: 'interactive' })
      const content = JSON.parse((captured as { content: string }).content)
      expect(content).toMatchObject({ data: { card_id: 'card_test_001' }, type: 'card' })
      expect(result.id).toBe('om_card1')
    })
  })

  describe('reactions', () => {
    let adapter: LarkAdapter = undefined!

    beforeEach(async () => {
      adapter = makeAdapter()
      await initAdapter(adapter)
    })

    it('addReaction sends emoji type', async () => {
      let captured: unknown = undefined
      server.use(
        tokenHandler,
        http.post(`${BASE}/open-apis/im/v1/messages/:id/reactions`, async ({ request }) => {
          captured = await request.json()
          return HttpResponse.json({ code: 0 })
        }),
      )
      const threadId = adapter.encodeThreadId({ chatId: 'oc_chat001' })
      await adapter.addReaction(threadId, 'om_msg1', 'THUMBSUP')
      expect(captured).toMatchObject({ reaction_type: { emoji_type: 'THUMBSUP' } })
    })

    it('addReaction maps Chat SDK emoji names to Feishu emoji_type values', async () => {
      let captured: unknown = undefined
      server.use(
        tokenHandler,
        http.post(`${BASE}/open-apis/im/v1/messages/:id/reactions`, async ({ request }) => {
          captured = await request.json()
          return HttpResponse.json({ code: 0 })
        }),
      )

      const threadId = adapter.encodeThreadId({ chatId: 'oc_chat001' })
      await adapter.addReaction(threadId, 'om_msg1', 'thumbs_up')

      expect(captured).toMatchObject({ reaction_type: { emoji_type: 'THUMBSUP' } })
    })

    it('addReaction handles EmojiValue object', async () => {
      let captured: unknown = undefined
      server.use(
        tokenHandler,
        http.post(`${BASE}/open-apis/im/v1/messages/:id/reactions`, async ({ request }) => {
          captured = await request.json()
          return HttpResponse.json({ code: 0 })
        }),
      )
      const threadId = adapter.encodeThreadId({ chatId: 'oc_chat001' })
      const emojiValue = { name: 'SMILE', toJSON: () => 'SMILE', toString: () => 'SMILE' }
      await adapter.addReaction(threadId, 'om_msg1', emojiValue)
      expect(captured).toMatchObject({ reaction_type: { emoji_type: 'SMILE' } })
    })

    it('addReaction maps EmojiValue names to Feishu emoji_type values', async () => {
      let captured: unknown = undefined
      server.use(
        tokenHandler,
        http.post(`${BASE}/open-apis/im/v1/messages/:id/reactions`, async ({ request }) => {
          captured = await request.json()
          return HttpResponse.json({ code: 0 })
        }),
      )

      const threadId = adapter.encodeThreadId({ chatId: 'oc_chat001' })
      const emojiValue = { name: 'smile', toJSON: () => 'smile', toString: () => 'smile' }
      await adapter.addReaction(threadId, 'om_msg1', emojiValue)
      expect(captured).toMatchObject({ reaction_type: { emoji_type: 'SMILE' } })
    })

    it('removeReaction lists then deletes', async () => {
      let deletedReactionId: unknown = undefined
      server.use(
        tokenHandler,
        http.get(`${BASE}/open-apis/im/v1/messages/:id/reactions`, () =>
          HttpResponse.json({
            code: 0,
            data: {
              items: [
                {
                  operator: { operator_id: 'ou_other_user', operator_type: 'user' },
                  reaction_id: 'rc_001',
                  reaction_type: { emoji_type: 'THUMBSUP' },
                },
                {
                  operator: { operator_id: 'test-app-id', operator_type: 'app' },
                  reaction_id: 'rc_002',
                  reaction_type: { emoji_type: 'THUMBSUP' },
                },
              ],
            },
          }),
        ),
        http.delete(`${BASE}/open-apis/im/v1/messages/:mid/reactions/:rid`, ({ params }) => {
          deletedReactionId = params['rid']
          return HttpResponse.json({ code: 0 })
        }),
      )
      const threadId = adapter.encodeThreadId({ chatId: 'oc_chat001' })
      await adapter.removeReaction(threadId, 'om_msg1', 'THUMBSUP')
      expect(deletedReactionId).toBe('rc_002')
    })

    it('removeReaction matches the mapped Feishu emoji_type before deleting', async () => {
      let deletedReactionId: unknown = undefined
      server.use(
        tokenHandler,
        http.get(`${BASE}/open-apis/im/v1/messages/:id/reactions`, () =>
          HttpResponse.json({
            code: 0,
            data: {
              items: [
                {
                  operator: { operator_id: 'ou_other_user', operator_type: 'user' },
                  reaction_id: 'rc_001',
                  reaction_type: { emoji_type: 'THUMBSUP' },
                },
                {
                  operator: { operator_id: 'test-app-id', operator_type: 'app' },
                  reaction_id: 'rc_002',
                  reaction_type: { emoji_type: 'THUMBSUP' },
                },
              ],
            },
          }),
        ),
        http.delete(`${BASE}/open-apis/im/v1/messages/:mid/reactions/:rid`, ({ params }) => {
          deletedReactionId = params['rid']
          return HttpResponse.json({ code: 0 })
        }),
      )

      const threadId = adapter.encodeThreadId({ chatId: 'oc_chat001' })
      await adapter.removeReaction(threadId, 'om_msg1', 'thumbs_up')

      expect(deletedReactionId).toBe('rc_002')
    })
  })

  describe('fetch methods', () => {
    let adapter: LarkAdapter = undefined!

    beforeEach(async () => {
      adapter = makeAdapter()
      await initAdapter(adapter)
    })

    it('fetchMessages returns paginated results', async () => {
      server.use(
        tokenHandler,
        http.get(`${BASE}/open-apis/im/v1/messages`, () =>
          HttpResponse.json({
            code: 0,
            data: {
              has_more: true,
              items: [
                {
                  body: { content: '{"text":"msg1"}' },
                  create_time: '1700000000000',
                  message_id: 'om_1',
                },
              ],
              page_token: 'next-tok',
            },
          }),
        ),
      )
      const threadId = adapter.encodeThreadId({ chatId: 'oc_chat001' })
      const result = await adapter.fetchMessages(threadId)
      expect(result.messages).toHaveLength(1)
      expect(result.nextCursor).toBe('next-tok')
    })

    it('fetchMessages uses thread container type for encoded thread IDs', async () => {
      let capturedUrl: URL | undefined
      server.use(
        tokenHandler,
        http.get(`${BASE}/open-apis/im/v1/messages`, ({ request }) => {
          capturedUrl = new URL(request.url)
          return HttpResponse.json({
            code: 0,
            data: {
              has_more: false,
              items: [
                {
                  body: { content: '{"text":"thread reply"}' },
                  chat_id: 'oc_chat001',
                  create_time: '1700000000000',
                  message_id: 'om_thread_reply',
                  root_id: 'om_root001',
                  thread_id: 'omt_thread001',
                },
              ],
            },
          })
        }),
      )

      const threadId = adapter.encodeThreadId({ chatId: 'oc_chat001', threadId: 'omt_thread001' })
      const result = await adapter.fetchMessages(threadId)

      expect(capturedUrl?.searchParams.get('container_id')).toBe('omt_thread001')
      expect(capturedUrl?.searchParams.get('container_id_type')).toBe('thread')
      expect(adapter.decodeThreadId(result.messages[0]!.threadId).threadId).toBe('omt_thread001')
    })

    it('fetchMessages defaults to backward paging and returns chronological order', async () => {
      let capturedUrl: URL | undefined
      server.use(
        tokenHandler,
        http.get(`${BASE}/open-apis/im/v1/messages`, ({ request }) => {
          capturedUrl = new URL(request.url)
          return HttpResponse.json({
            code: 0,
            data: {
              has_more: false,
              items: [
                {
                  body: { content: '{"text":"newest"}' },
                  create_time: '1700000001000',
                  message_id: 'om_new',
                },
                {
                  body: { content: '{"text":"older"}' },
                  create_time: '1700000000000',
                  message_id: 'om_old',
                },
              ],
            },
          })
        }),
      )

      const threadId = adapter.encodeThreadId({ chatId: 'oc_chat001' })
      const result = await adapter.fetchMessages(threadId)

      expect(capturedUrl?.searchParams.get('sort_type')).toBe('ByCreateTimeDesc')
      expect(result.messages.map((message) => message.id)).toEqual(['om_old', 'om_new'])
    })

    it('fetchMessages passes direction as sort_type', async () => {
      let capturedUrl: URL | undefined
      server.use(
        tokenHandler,
        http.get(`${BASE}/open-apis/im/v1/messages`, ({ request }) => {
          capturedUrl = new URL(request.url)
          return HttpResponse.json({
            code: 0,
            data: { has_more: false, items: [] },
          })
        }),
      )
      const threadId = adapter.encodeThreadId({ chatId: 'oc_chat001' })
      await adapter.fetchMessages(threadId, { direction: 'backward' })
      expect(capturedUrl?.searchParams.get('sort_type')).toBe('ByCreateTimeDesc')
    })

    it('fetchMessages backward direction returns chronological order', async () => {
      server.use(
        tokenHandler,
        http.get(`${BASE}/open-apis/im/v1/messages`, () =>
          HttpResponse.json({
            code: 0,
            data: {
              has_more: false,
              items: [
                {
                  body: { content: '{"text":"newest"}' },
                  create_time: '1700000001000',
                  message_id: 'om_new',
                },
                {
                  body: { content: '{"text":"older"}' },
                  create_time: '1700000000000',
                  message_id: 'om_old',
                },
              ],
            },
          }),
        ),
      )

      const threadId = adapter.encodeThreadId({ chatId: 'oc_chat001' })
      const result = await adapter.fetchMessages(threadId, { direction: 'backward' })

      expect(result.messages.map((message) => message.id)).toEqual(['om_old', 'om_new'])
    })

    it('fetchMessages forward direction maps to ByCreateTimeAsc', async () => {
      let capturedUrl: URL | undefined
      server.use(
        tokenHandler,
        http.get(`${BASE}/open-apis/im/v1/messages`, ({ request }) => {
          capturedUrl = new URL(request.url)
          return HttpResponse.json({
            code: 0,
            data: { has_more: false, items: [] },
          })
        }),
      )
      const threadId = adapter.encodeThreadId({ chatId: 'oc_chat001' })
      await adapter.fetchMessages(threadId, { direction: 'forward' })
      expect(capturedUrl?.searchParams.get('sort_type')).toBe('ByCreateTimeAsc')
    })

    it('fetchMessages builds author from sender in API response', async () => {
      server.use(
        tokenHandler,
        http.get(`${BASE}/open-apis/im/v1/messages`, () =>
          HttpResponse.json({
            code: 0,
            data: {
              has_more: false,
              items: [
                {
                  body: { content: '{"text":"from user"}' },
                  create_time: '1700000000000',
                  message_id: 'om_s1',
                  sender: { id: 'ou_user1', id_type: 'open_id', sender_type: 'user' },
                  updated: true,
                },
              ],
            },
          }),
        ),
      )
      const threadId = adapter.encodeThreadId({ chatId: 'oc_chat001' })
      const result = await adapter.fetchMessages(threadId)
      const msg = result.messages[0]!
      expect(msg.author.userId).toBe('ou_user1')
      expect(msg.author.fullName).toBe('Alice')
      expect(msg.author.userName).toBe('Alice')
      expect(msg.author.isBot).toBe(false)
      expect(msg.author.isMe).toBe(false)
      expect(msg.metadata.edited).toBe(true)
    })

    it('fetchMessages returns unknownAuthor when sender is absent', async () => {
      server.use(
        tokenHandler,
        http.get(`${BASE}/open-apis/im/v1/messages`, () =>
          HttpResponse.json({
            code: 0,
            data: {
              has_more: false,
              items: [
                {
                  body: { content: '{"text":"no sender"}' },
                  create_time: '1700000000000',
                  message_id: 'om_ns',
                },
              ],
            },
          }),
        ),
      )
      const threadId = adapter.encodeThreadId({ chatId: 'oc_chat001' })
      const result = await adapter.fetchMessages(threadId)
      expect(result.messages[0]!.author.isBot).toBe('unknown')
    })

    it('fetchMessages identifies app sender as bot', async () => {
      server.use(
        tokenHandler,
        http.get(`${BASE}/open-apis/im/v1/messages`, () =>
          HttpResponse.json({
            code: 0,
            data: {
              has_more: false,
              items: [
                {
                  body: { content: '{"text":"bot msg"}' },
                  create_time: '1700000000000',
                  message_id: 'om_bot',
                  sender: { id: 'test-app-id', id_type: 'app_id', sender_type: 'app' },
                },
              ],
            },
          }),
        ),
      )
      const threadId = adapter.encodeThreadId({ chatId: 'oc_chat001' })
      const result = await adapter.fetchMessages(threadId)
      const msg = result.messages[0]!
      expect(msg.author.isBot).toBe(true)
      expect(msg.author.isMe).toBe(true)
    })

    it('fetchThread returns thread info', async () => {
      server.use(
        tokenHandler,
        http.get(`${BASE}/open-apis/im/v1/chats/:id`, () =>
          HttpResponse.json({ code: 0, data: { name: 'Test Chat' } }),
        ),
      )
      const threadId = adapter.encodeThreadId({ chatId: 'oc_chat001' })
      const info = await adapter.fetchThread(threadId)
      expect(info.id).toBe(threadId)
      expect(info.channelName).toBe('Test Chat')
    })

    it('fetchMessage returns a single message', async () => {
      server.use(
        tokenHandler,
        http.get(`${BASE}/open-apis/im/v1/messages/:id`, () =>
          HttpResponse.json({
            code: 0,
            data: {
              items: [
                {
                  body: { content: '{"text":"fetched"}' },
                  create_time: '1700000000000',
                  message_id: 'om_f1',
                },
              ],
            },
          }),
        ),
      )
      const threadId = adapter.encodeThreadId({ chatId: 'oc_chat001' })
      const msg = await adapter.fetchMessage(threadId, 'om_f1')
      expect(msg).not.toBeNull()
      expect(msg!.id).toBe('om_f1')
    })

    it('fetchChannelInfo returns channel metadata with memberCount from users and bots', async () => {
      server.use(
        tokenHandler,
        http.get(`${BASE}/open-apis/im/v1/chats/:id`, () =>
          HttpResponse.json({
            code: 0,
            data: { bot_count: '3', chat_mode: 'group', name: 'Channel X', user_count: '42' },
          }),
        ),
      )
      const info = await adapter.fetchChannelInfo('oc_chat001')
      expect(info.id).toBe('oc_chat001')
      expect(info.name).toBe('Channel X')
      expect(info.memberCount).toBe(45)
      expect(info.isDM).toBe(false)
    })
  })

  describe('DM', () => {
    let adapter: LarkAdapter = undefined!

    beforeEach(async () => {
      adapter = makeAdapter()
      await initAdapter(adapter)
    })

    it('openDM creates p2p chat and returns threadId', async () => {
      server.use(
        tokenHandler,
        http.post(`${BASE}/open-apis/im/v1/chats`, () =>
          HttpResponse.json({ code: 0, data: { chat_id: 'oc_dm_new' } }),
        ),
      )
      const threadId = await adapter.openDM('ou_user1')
      expect(threadId).toContain('lark:')
      expect(adapter.isDM(threadId)).toBe(true)
    })

    it('isDM returns false for unknown threads', () => {
      const threadId = adapter.encodeThreadId({ chatId: 'oc_group1' })
      expect(adapter.isDM(threadId)).toBe(false)
    })

    it('isDM returns true after receiving a p2p message', async () => {
      const dmAdapter = makeAdapter()
      const dmMockChat = await initAdapter(dmAdapter)

      const event = makeDMEvent()
      await dmAdapter.handleWebhook(makeRequest(event))

      // Execute the factory to trigger cache write
      const factory = dmMockChat.processMessage.mock.calls[0]![2]
      await (factory as () => Promise<unknown>)()

      const threadId = dmAdapter.encodeThreadId({ chatId: 'oc_dm001' })
      expect(dmAdapter.isDM(threadId)).toBe(true)
    })

    it('fetchThread populates channel cache for isDM', async () => {
      server.use(
        http.get(`${BASE}/open-apis/im/v1/chats/:chatId`, () =>
          HttpResponse.json({
            code: 0,
            data: { chat_mode: 'p2p', chat_type: 'p2p', name: 'DM Chat' },
          }),
        ),
      )

      const threadId = adapter.encodeThreadId({ chatId: 'oc_dm001' })
      await adapter.fetchThread(threadId)
      expect(adapter.isDM(threadId)).toBe(true)
    })
  })

  describe('misc', () => {
    it('startTyping is a no-op', async () => {
      const adapter = makeAdapter()
      await expect(adapter.startTyping('any')).resolves.toBeUndefined()
    })

    it('renderFormatted converts AST to string', async () => {
      const adapter = makeAdapter()
      await initAdapter(adapter)
      const ast = adapter['converter'].toAst('{"text":"hello world"}')
      const result = adapter.renderFormatted(ast)
      expect(typeof result).toBe('string')
      expect(result).toContain('hello world')
    })

    it('name is "lark"', () => {
      expect(makeAdapter().name).toBe('lark')
    })
  })

  describe('stream', () => {
    let adapter: LarkAdapter = undefined!

    beforeEach(async () => {
      adapter = makeAdapter()
      await initAdapter(adapter)
    })

    it('creates streaming card, sends updates, then closes streaming', async () => {
      const streamUpdates: Array<{ content: string; sequence: number }> = []
      let settingsCaptured: unknown = undefined

      server.use(
        tokenHandler,
        createCardHandler,
        http.post(`${BASE}/open-apis/im/v1/messages`, () =>
          HttpResponse.json({ code: 0, data: { message_id: 'om_stream1' } }),
        ),
        http.put(
          `${BASE}/open-apis/cardkit/v1/cards/:cardId/elements/:elementId/content`,
          async ({ request }) => {
            const body = (await request.json()) as { content: string; sequence: number }
            streamUpdates.push(body)
            return HttpResponse.json({ code: 0, data: {} })
          },
        ),
        http.patch(`${BASE}/open-apis/cardkit/v1/cards/:cardId/settings`, async ({ request }) => {
          settingsCaptured = await request.json()
          return HttpResponse.json({ code: 0, data: {} })
        }),
      )

      const threadId = adapter.encodeThreadId({ chatId: 'oc_chat001' })
      const result = await adapter.stream(threadId, makeStreamGen()())

      expect(result.id).toBe('om_stream1')
      expect(streamUpdates).toHaveLength(3)
      expect(streamUpdates[streamUpdates.length - 1]!.content).toBe('Hello World!')
      expect(streamUpdates.map((item) => item.sequence)).toEqual([1, 2, 3])
      expect(settingsCaptured).toMatchObject({
        settings: expect.stringContaining('streaming_mode'),
      })
    })

    it('closes streaming mode even on stream error', async () => {
      let settingsClosed = false

      server.use(
        tokenHandler,
        createCardHandler,
        http.post(`${BASE}/open-apis/im/v1/messages`, () =>
          HttpResponse.json({ code: 0, data: { message_id: 'om_stream2' } }),
        ),
        http.put(`${BASE}/open-apis/cardkit/v1/cards/:cardId/elements/:elementId/content`, () =>
          HttpResponse.json({ code: 0, data: {} }),
        ),
        http.patch(`${BASE}/open-apis/cardkit/v1/cards/:cardId/settings`, () => {
          settingsClosed = true
          return HttpResponse.json({ code: 0, data: {} })
        }),
      )

      const gen = async function* streamChunks() {
        yield 'partial'
        throw new Error('stream broke')
      }

      const threadId = adapter.encodeThreadId({ chatId: 'oc_chat001' })
      await expect(adapter.stream(threadId, gen())).rejects.toThrow('stream broke')
      expect(settingsClosed).toBe(true)
    })
  })

  describe('channel, visibility, and ephemeral', () => {
    it('postEphemeral sends text wrapped as markdown card', async () => {
      const adapter = makeAdapter()
      await initAdapter(adapter)
      let captured: EphemeralSendPayload | undefined
      server.use(
        tokenHandler,
        http.post(`${BASE}/open-apis/ephemeral/v1/send`, async ({ request }) => {
          captured = (await request.json()) as EphemeralSendPayload
          return HttpResponse.json({ code: 0 })
        }),
      )
      const threadId = adapter.encodeThreadId({ chatId: 'oc_chat001' })
      const result = await adapter.postEphemeral(threadId, 'ou_user1', 'secret msg')
      expect(captured).toMatchObject({
        chat_id: 'oc_chat001',
        msg_type: 'interactive',
        open_id: 'ou_user1',
      })
      const card = captured?.card
      expect(card?.schema).toBe('2.0')
      expect(card?.body?.elements?.[0]?.tag).toBe('markdown')
      expect(card?.body?.elements?.[0]?.content).toBe('secret msg')
      expect(result.usedFallback).toBe(false)
    })

    it('postEphemeral sends CardElement as interactive card', async () => {
      const adapter = makeAdapter()
      await initAdapter(adapter)
      let captured: EphemeralSendPayload | undefined
      server.use(
        tokenHandler,
        createCardHandler,
        http.post(`${BASE}/open-apis/ephemeral/v1/send`, async ({ request }) => {
          captured = (await request.json()) as EphemeralSendPayload
          return HttpResponse.json({ code: 0 })
        }),
      )
      const card = { children: [], title: 'Ephemeral Card', type: 'card' as const }
      const threadId = adapter.encodeThreadId({ chatId: 'oc_chat001' })
      await adapter.postEphemeral(threadId, 'ou_user1', card)
      const cardObj = captured?.card
      expect(cardObj?.schema).toBe('2.0')
    })

    it('botUserId is set from bot info after initialization', async () => {
      const adapter = makeAdapter()
      expect(adapter.botUserId).toBe('')
      await initAdapter(adapter)
      expect(adapter.botUserId).toBe('ou_bot001')
    })

    it('postChannelMessage sends to channel by chatId', async () => {
      const adapter = makeAdapter()
      await initAdapter(adapter)
      let captured: unknown = undefined
      server.use(
        tokenHandler,
        http.post(`${BASE}/open-apis/im/v1/messages`, async ({ request }) => {
          captured = await request.json()
          return HttpResponse.json({ code: 0, data: { message_id: 'om_ch_msg' } })
        }),
      )

      const result = await adapter.postChannelMessage('oc_chat001', 'hello channel')
      expect(captured).toMatchObject({ receive_id: 'oc_chat001' })
      expect(result.id).toBe('om_ch_msg')
    })

    it('fetchChannelMessages fetches by channelId with pagination', async () => {
      const adapter = makeAdapter()
      await initAdapter(adapter)
      let capturedUrl: URL | undefined
      server.use(
        tokenHandler,
        http.get(`${BASE}/open-apis/im/v1/messages`, ({ request }) => {
          capturedUrl = new URL(request.url)
          return HttpResponse.json({
            code: 0,
            data: {
              has_more: true,
              items: [
                {
                  body: { content: '{"text":"ch msg"}' },
                  create_time: '1700000000000',
                  message_id: 'om_ch1',
                },
              ],
              page_token: 'next',
            },
          })
        }),
      )

      const result = await adapter.fetchChannelMessages('oc_chat001')
      expect(result.messages).toHaveLength(1)
      expect(result.messages.at(0)!.text).toBe('ch msg')
      expect(result.nextCursor).toBe('next')
      expect(capturedUrl?.searchParams.get('container_id_type')).toBe('chat')
    })

    it('fetchChannelMessages defaults to backward paging and returns chronological order', async () => {
      const adapter = makeAdapter()
      await initAdapter(adapter)
      let capturedUrl: URL | undefined
      server.use(
        tokenHandler,
        http.get(`${BASE}/open-apis/im/v1/messages`, ({ request }) => {
          capturedUrl = new URL(request.url)
          return HttpResponse.json({
            code: 0,
            data: {
              has_more: false,
              items: [
                {
                  body: { content: '{"text":"newest"}' },
                  create_time: '1700000001000',
                  message_id: 'om_new',
                },
                {
                  body: { content: '{"text":"older"}' },
                  create_time: '1700000000000',
                  message_id: 'om_old',
                },
              ],
            },
          })
        }),
      )

      const result = await adapter.fetchChannelMessages('oc_chat001')

      expect(capturedUrl?.searchParams.get('sort_type')).toBe('ByCreateTimeDesc')
      expect(result.messages.map((message) => message.id)).toEqual(['om_old', 'om_new'])
    })

    it('fetchChannelMessages backward direction returns chronological order', async () => {
      const adapter = makeAdapter()
      await initAdapter(adapter)
      server.use(
        tokenHandler,
        http.get(`${BASE}/open-apis/im/v1/messages`, () =>
          HttpResponse.json({
            code: 0,
            data: {
              has_more: false,
              items: [
                {
                  body: { content: '{"text":"newest"}' },
                  create_time: '1700000001000',
                  message_id: 'om_new',
                },
                {
                  body: { content: '{"text":"older"}' },
                  create_time: '1700000000000',
                  message_id: 'om_old',
                },
              ],
            },
          }),
        ),
      )

      const result = await adapter.fetchChannelMessages('oc_chat001', { direction: 'backward' })

      expect(result.messages.map((message) => message.id)).toEqual(['om_old', 'om_new'])
    })

    it('getChannelVisibility returns private for known DM channels', async () => {
      const adapter = makeAdapter()
      await initAdapter(adapter)
      server.use(
        tokenHandler,
        http.post(`${BASE}/open-apis/im/v1/chats`, () =>
          HttpResponse.json({ code: 0, data: { chat_id: 'oc_dm' } }),
        ),
      )
      await adapter.openDM('ou_user1')
      const threadId = adapter.encodeThreadId({ chatId: 'oc_dm' })
      expect(adapter.getChannelVisibility(threadId)).toBe('private')
    })

    it('getChannelVisibility returns unknown without cached info', async () => {
      const adapter = makeAdapter()
      await initAdapter(adapter)
      const threadId = adapter.encodeThreadId({ chatId: 'oc_unknown' })
      expect(adapter.getChannelVisibility(threadId)).toBe('unknown')
    })

    it('fetchChannelInfo returns workspace for public chats', async () => {
      const adapter = makeAdapter()
      await initAdapter(adapter)
      server.use(
        tokenHandler,
        http.get(`${BASE}/open-apis/im/v1/chats/:chatId`, () =>
          HttpResponse.json({
            code: 0,
            data: { chat_mode: 'group', chat_type: 'public', name: 'Public' },
          }),
        ),
      )
      const info = await adapter.fetchChannelInfo('oc_pub')
      expect(info.channelVisibility).toBe('workspace')
      expect(adapter.getChannelVisibility(adapter.encodeThreadId({ chatId: 'oc_pub' }))).toBe(
        'workspace',
      )
    })

    it('fetchChannelInfo returns private for private chats', async () => {
      const adapter = makeAdapter()
      await initAdapter(adapter)
      server.use(
        tokenHandler,
        http.get(`${BASE}/open-apis/im/v1/chats/:chatId`, () =>
          HttpResponse.json({
            code: 0,
            data: { chat_mode: 'group', chat_type: 'private', name: 'Private' },
          }),
        ),
      )
      const info = await adapter.fetchChannelInfo('oc_priv')
      expect(info.channelVisibility).toBe('private')
    })

    it('fetchChannelInfo returns external visibility for external chats', async () => {
      const adapter = makeAdapter()
      await initAdapter(adapter)
      server.use(
        tokenHandler,
        http.get(`${BASE}/open-apis/im/v1/chats/:chatId`, () =>
          HttpResponse.json({
            code: 0,
            data: {
              chat_mode: 'group',
              chat_type: 'public',
              external: true,
              name: 'External',
            },
          }),
        ),
      )
      const info = await adapter.fetchChannelInfo('oc_ext')
      expect(info.channelVisibility).toBe('external')
      expect(adapter.getChannelVisibility(adapter.encodeThreadId({ chatId: 'oc_ext' }))).toBe(
        'external',
      )
    })
  })

  describe('lookupUser cache', () => {
    const USER_CACHE_TTL_MS = 8 * 24 * 60 * 60 * 1000
    const FAILED_LOOKUP_TTL_MS = 1 * 24 * 60 * 60 * 1000

    const makeUserEvent = (openId: string) =>
      makeMessageEvent({
        event: {
          message: {
            chat_id: 'oc_chat001',
            chat_type: 'group',
            content: '{"text":"hello"}',
            create_time: '1700000000000',
            message_id: `om_msg_${openId}`,
            message_type: 'text',
          },
          sender: {
            sender_id: { open_id: openId },
            sender_type: 'user',
          },
        },
      })

    const executeFactory = async (mockChat: ReturnType<typeof makeMockChat>) => {
      const calls = mockChat.processMessage.mock.calls
      const factory = calls[calls.length - 1]![2]
      return (factory as () => Promise<unknown>)()
    }

    it('resolves user name from API on cache miss', async () => {
      const adapter = makeAdapter()
      const mockChat = await initAdapter(adapter)

      await adapter.handleWebhook(makeRequest(makeUserEvent('ou_user1')))
      await executeFactory(mockChat)

      const userSetCalls = mockChat._state.set.mock.calls.filter((call: unknown[]) =>
        (call[0] as string).startsWith('lark:user:'),
      )
      expect(userSetCalls.length).toBeGreaterThanOrEqual(1)
      const [key, value, ttl] = userSetCalls[0]!
      expect(key).toBe('lark:user:ou_user1')
      expect(value).toEqual({ name: 'Alice' })
      expect(ttl).toBe(USER_CACHE_TTL_MS)
    })

    it('uses state adapter cache on memory miss', async () => {
      const adapter = makeAdapter()
      const mockChat = await initAdapter(adapter)

      mockChat._state.get.mockResolvedValueOnce({ name: 'CachedBob' })

      await adapter.handleWebhook(makeRequest(makeUserEvent('ou_user2')))
      const msg = await executeFactory(mockChat)

      expect((msg as { author: { fullName: string } }).author.fullName).toBe('CachedBob')
    })

    it('uses in-memory cache on repeated calls', async () => {
      const adapter = makeAdapter()
      const mockChat = await initAdapter(adapter)

      // First call: API lookup, seeds in-memory cache
      await adapter.handleWebhook(makeRequest(makeUserEvent('ou_user1')))
      await executeFactory(mockChat)

      // Clear state mock history — second call should hit in-memory cache
      mockChat._state.get.mockClear()

      await adapter.handleWebhook(makeRequest(makeUserEvent('ou_user1')))
      await executeFactory(mockChat)

      // state.get should not have been called — in-memory cache handled it
      expect(mockChat._state.get).not.toHaveBeenCalledWith('lark:user:ou_user1')
    })

    it('caches failed lookup with short TTL', async () => {
      const adapter = makeAdapter()
      const mockChat = await initAdapter(adapter)

      server.use(
        http.get(`${BASE}/open-apis/contact/v3/users/:userId`, () =>
          HttpResponse.json({ code: 1 }, { status: 500 }),
        ),
      )

      await adapter.handleWebhook(makeRequest(makeUserEvent('ou_user_bad')))
      await executeFactory(mockChat)

      const userSetCalls = mockChat._state.set.mock.calls.filter((call: unknown[]) =>
        (call[0] as string).startsWith('lark:user:'),
      )
      expect(userSetCalls.length).toBeGreaterThanOrEqual(1)
      const [key, value, ttl] = userSetCalls[0]!
      expect(key).toBe('lark:user:ou_user_bad')
      expect(value).toEqual({ name: 'ou_user_bad' })
      expect(ttl).toBe(FAILED_LOOKUP_TTL_MS)
    })

    it('seeds cache from webhook mentions', async () => {
      const adapter = makeAdapter()
      const mockChat = await initAdapter(adapter)

      const eventWithMention = makeMessageEvent({
        event: {
          message: {
            chat_id: 'oc_chat001',
            chat_type: 'group',
            content: '{"text":"@_user_1 hi"}',
            create_time: '1700000000000',
            mentions: [
              { id: { open_id: 'ou_mentioned1' }, key: '@_user_1', name: 'MentionedAlice' },
            ],
            message_id: 'om_mention_test',
            message_type: 'text',
          },
          sender: {
            sender_id: { open_id: 'ou_sender1' },
            sender_type: 'user',
          },
        },
      })

      await adapter.handleWebhook(makeRequest(eventWithMention))
      await executeFactory(mockChat)

      const mentionSetCall = mockChat._state.set.mock.calls.find(
        (call: unknown[]) => call[0] === 'lark:user:ou_mentioned1',
      )
      expect(mentionSetCall).toBeDefined()
      expect(mentionSetCall![1]).toEqual({ name: 'MentionedAlice' })
      expect(mentionSetCall![2]).toBe(USER_CACHE_TTL_MS)
    })
  })
})
