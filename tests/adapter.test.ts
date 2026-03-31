import { HttpResponse, http } from 'msw'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { LarkAdapter } from '../src/adapter.ts'
import type { LarkRawMessage } from '../src/types.ts'
import { fixtures } from './fixtures.ts'
import { server } from './setup.ts'

const {
  makeCardActionEvent,
  makeChallengeEvent,
  makeMessageEvent,
  makeModalResetEvent,
  makeModalSubmitEvent,
  makeReactionEvent,
  makeRequest,
  makeSelectActionEvent,
} = fixtures

const BASE = 'https://open.feishu.cn'
const TOKEN_URL = `${BASE}/open-apis/auth/v3/tenant_access_token/internal`
const SEGMENT_COUNT_CHAT_ONLY = 2
const SEGMENT_COUNT_WITH_ROOT = 3
const HTTP_OK = 200
const HTTP_BAD_REQUEST = 400
const ONCE = 1
const ONE_MESSAGE = 1
const FIRST_MESSAGE = 0
const STREAM_CHUNK_COUNT = 3
const MEMBER_COUNT_42 = 42
const SEQ_1 = 1
const SEQ_2 = 2
const SEQ_3 = 3

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

const makeAdapter = () =>
  new LarkAdapter({
    appId: 'test-app-id',
    appSecret: 'test-app-secret',
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

beforeAll(() => server.listen({ onUnhandledRequest: 'bypass' }))
afterEach(() => server.resetHandlers())
afterAll(() => server.close())

describe('LarkAdapter', () => {
  describe('thread ID encoding', () => {
    it('encodes chatId only', () => {
      const adapter = makeAdapter()
      const threadId = adapter.encodeThreadId({ chatId: 'oc_chat001' })
      expect(threadId).toMatch(/^lark:/)
      expect(threadId.split(':')).toHaveLength(SEGMENT_COUNT_CHAT_ONLY)
    })

    it('encodes chatId + rootMessageId', () => {
      const adapter = makeAdapter()
      const threadId = adapter.encodeThreadId({
        chatId: 'oc_chat001',
        rootMessageId: 'om_msg001',
      })
      expect(threadId.split(':')).toHaveLength(SEGMENT_COUNT_WITH_ROOT)
    })

    it('decode round-trips with chatId only', () => {
      const adapter = makeAdapter()
      const original = { chatId: 'oc_chat001' }
      const threadId = adapter.encodeThreadId(original)
      const decoded = adapter.decodeThreadId(threadId)
      expect(decoded.chatId).toBe('oc_chat001')
      expect(decoded.rootMessageId).toBeUndefined()
    })

    it('decode round-trips with chatId + rootMessageId', () => {
      const adapter = makeAdapter()
      const original = { chatId: 'oc_chat001', rootMessageId: 'om_msg001' }
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

      expect(res.status).toBe(HTTP_OK)
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
      expect((await adapter.handleWebhook(req)).status).toBe(HTTP_BAD_REQUEST)
    })

    it('returns 200 immediately for normal events', async () => {
      const adapter = makeAdapter()
      await initAdapter(adapter)

      const req = makeRequest(makeMessageEvent())
      expect((await adapter.handleWebhook(req)).status).toBe(HTTP_OK)
    })

    it('routes message event to processMessage with factory', async () => {
      const adapter = makeAdapter()
      const mockChat = await initAdapter(adapter)

      await adapter.handleWebhook(makeRequest(makeMessageEvent()))
      expect(mockChat.processMessage).toHaveBeenCalledTimes(ONCE)

      const call = mockChat.processMessage.mock.calls[0]!
      expect(call[0]).toBe(adapter)
      expect(call[1]).toMatch(/^lark:/)
      expect(typeof call[2]).toBe('function')

      // Execute factory to get message
      const message = await (call[2] as () => Promise<unknown>)()
      expect((message as { text: string }).text).toContain('hello bot')
    })

    it('routes reaction event to processReaction', async () => {
      const adapter = makeAdapter()
      const mockChat = await initAdapter(adapter)

      server.use(
        http.get(`${BASE}/open-apis/im/v1/messages/:message_id`, () =>
          HttpResponse.json({
            code: 0,
            data: {
              items: [{ chat_id: 'oc_chat001', message_id: 'om_msg001', root_id: '' }],
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
      expect(res.status).toBe(HTTP_OK)
      await Promise.allSettled(promises)
      // Wait for async threadId + user resolution
      await vi.waitFor(() => {
        expect(mockChat.processReaction).toHaveBeenCalledTimes(ONCE)
      })
      const call = mockChat.processReaction.mock.calls[FIRST_MESSAGE]!
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
    })

    it('routes card.action.trigger to processAction', async () => {
      const adapter = makeAdapter()
      const mockChat = await initAdapter(adapter)

      const event = makeCardActionEvent('approve', 'order_123')
      const res = await adapter.handleWebhook(makeRequest(event))
      expect(res.status).toBe(HTTP_OK)
      expect(mockChat.processAction).toHaveBeenCalledTimes(ONCE)

      const call = mockChat.processAction.mock.calls[FIRST_MESSAGE]!
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
      expect(actionEvent.triggerId).toBe('oc_chat001:om_card_msg001')
      expect(actionEvent.user.userId).toBe('ou_user1')
    })

    it('routes select action with option as value', async () => {
      const adapter = makeAdapter()
      const mockChat = await initAdapter(adapter)

      const event = makeSelectActionEvent('priority', 'high')
      await adapter.handleWebhook(makeRequest(event))
      expect(mockChat.processAction).toHaveBeenCalledTimes(ONCE)

      const call = mockChat.processAction.mock.calls[FIRST_MESSAGE]!
      const actionEvent = call[0] as { actionId: string; value: string }
      expect(actionEvent.actionId).toBe('priority')
      expect(actionEvent.value).toBe('high')
    })

    it('routes modal form submit to processModalSubmit', async () => {
      const adapter = makeAdapter()
      const mockChat = await initAdapter(adapter)
      mockChat.processModalSubmit.mockResolvedValue(undefined)

      const event = makeModalSubmitEvent(
        'feedback_form',
        { message: 'Great!' },
        'ctx_1',
        '{"k":"v"}',
      )
      await adapter.handleWebhook(makeRequest(event))

      // processModalSubmit is called async — wait a tick
      await new Promise((r) => setTimeout(r, 0))
      expect(mockChat.processModalSubmit).toHaveBeenCalledTimes(ONCE)

      const call = mockChat.processModalSubmit.mock.calls[FIRST_MESSAGE]!
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

    it('routes modal form reset with notifyOnClose to processModalClose', async () => {
      const adapter = makeAdapter()
      const mockChat = await initAdapter(adapter)

      const event = makeModalResetEvent('feedback_form', true)
      await adapter.handleWebhook(makeRequest(event))

      expect(mockChat.processModalClose).toHaveBeenCalledTimes(ONCE)
      const call = mockChat.processModalClose.mock.calls[FIRST_MESSAGE]!
      const closeEvent = call[0] as { callbackId: string }
      expect(closeEvent.callbackId).toBe('feedback_form')
    })

    it('does not call processModalClose when notifyOnClose is false', async () => {
      const adapter = makeAdapter()
      const mockChat = await initAdapter(adapter)

      const event = makeModalResetEvent('feedback_form', false)
      await adapter.handleWebhook(makeRequest(event))

      expect(mockChat.processModalClose).not.toHaveBeenCalled()
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
          return HttpResponse.json({ code: 0, data: { message_id: 'om_sent1' } })
        }),
      )
      const threadId = adapter.encodeThreadId({ chatId: 'oc_chat001' })
      const result = await adapter.postMessage(threadId, 'hello')
      expect(captured).toMatchObject({ msg_type: 'text', receive_id: 'oc_chat001' })
      expect(result.id).toBe('om_sent1')
    })

    it('postMessage replies when rootMessageId present', async () => {
      let replyTo: unknown = undefined
      server.use(
        tokenHandler,
        http.post(`${BASE}/open-apis/im/v1/messages/:id/reply`, ({ params }) => {
          replyTo = params['id']
          return HttpResponse.json({ code: 0, data: { message_id: 'om_reply1' } })
        }),
      )
      const threadId = adapter.encodeThreadId({ chatId: 'oc_chat001', rootMessageId: 'om_root1' })
      await adapter.postMessage(threadId, 'reply text')
      expect(replyTo).toBe('om_root1')
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

    it('removeReaction lists then deletes', async () => {
      let deletedReactionId: unknown = undefined
      server.use(
        tokenHandler,
        http.get(`${BASE}/open-apis/im/v1/messages/:id/reactions`, () =>
          HttpResponse.json({
            code: 0,
            data: {
              items: [{ reaction_id: 'rc_001', reaction_type: { emoji_type: 'THUMBSUP' } }],
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
      expect(deletedReactionId).toBe('rc_001')
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
      expect(result.messages).toHaveLength(ONE_MESSAGE)
      expect(result.nextCursor).toBe('next-tok')
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
      const msg = result.messages[FIRST_MESSAGE]!
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
      expect(result.messages[FIRST_MESSAGE]!.author.isBot).toBe('unknown')
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
                  sender: { id: 'ou_bot001', id_type: 'app_id', sender_type: 'app' },
                },
              ],
            },
          }),
        ),
      )
      const threadId = adapter.encodeThreadId({ chatId: 'oc_chat001' })
      const result = await adapter.fetchMessages(threadId)
      const msg = result.messages[FIRST_MESSAGE]!
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

    it('fetchChannelInfo returns channel metadata with memberCount from user_count', async () => {
      server.use(
        tokenHandler,
        http.get(`${BASE}/open-apis/im/v1/chats/:id`, () =>
          HttpResponse.json({
            code: 0,
            data: { chat_mode: 'group', name: 'Channel X', user_count: '42' },
          }),
        ),
      )
      const info = await adapter.fetchChannelInfo('oc_chat001')
      expect(info.id).toBe('oc_chat001')
      expect(info.name).toBe('Channel X')
      expect(info.memberCount).toBe(MEMBER_COUNT_42)
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
      expect(streamUpdates).toHaveLength(STREAM_CHUNK_COUNT)
      expect(streamUpdates[streamUpdates.length - ONCE]!.content).toBe('Hello World!')
      expect(streamUpdates.map((item) => item.sequence)).toEqual([SEQ_1, SEQ_2, SEQ_3])
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
      let captured: Record<string, unknown> | undefined
      server.use(
        tokenHandler,
        http.post(`${BASE}/open-apis/ephemeral/v1/send`, async ({ request }) => {
          captured = (await request.json()) as Record<string, unknown>
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
      const card = captured!['card'] as {
        body?: { elements?: Array<{ content?: string; tag?: string }> }
        schema?: string
      }
      expect(card.schema).toBe('2.0')
      expect(card.body?.elements?.[FIRST_MESSAGE]?.tag).toBe('markdown')
      expect(card.body?.elements?.[FIRST_MESSAGE]?.content).toBe('secret msg')
      expect(result.usedFallback).toBe(false)
    })

    it('postEphemeral sends CardElement as interactive card', async () => {
      const adapter = makeAdapter()
      await initAdapter(adapter)
      let captured: Record<string, unknown> | undefined
      server.use(
        tokenHandler,
        createCardHandler,
        http.post(`${BASE}/open-apis/ephemeral/v1/send`, async ({ request }) => {
          captured = (await request.json()) as Record<string, unknown>
          return HttpResponse.json({ code: 0 })
        }),
      )
      const card = { children: [], title: 'Ephemeral Card', type: 'card' as const }
      const threadId = adapter.encodeThreadId({ chatId: 'oc_chat001' })
      await adapter.postEphemeral(threadId, 'ou_user1', card)
      const cardObj = captured!['card'] as { schema?: string }
      expect(cardObj.schema).toBe('2.0')
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
      server.use(
        tokenHandler,
        http.get(`${BASE}/open-apis/im/v1/messages`, () =>
          HttpResponse.json({
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
          }),
        ),
      )

      const result = await adapter.fetchChannelMessages('oc_chat001')
      expect(result.messages).toHaveLength(ONE_MESSAGE)
      expect(result.messages.at(FIRST_MESSAGE)!.text).toBe('ch msg')
      expect(result.nextCursor).toBe('next')
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
  })
})
