import { HttpResponse, http } from 'msw'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import LarkAdapter from '../src/adapter.ts'
import type { LarkRawMessage } from '../src/types.ts'
import fixtures from './fixtures.ts'
import server from './setup.ts'

const { makeChallengeEvent, makeMessageEvent, makeReactionEvent, makeRequest } = fixtures

const BASE = 'https://open.feishu.cn'
const TOKEN_URL = `${BASE}/open-apis/auth/v3/tenant_access_token/internal`
const SEGMENT_COUNT_CHAT_ONLY = 2
const SEGMENT_COUNT_WITH_ROOT = 3
const HTTP_OK = 200
const HTTP_BAD_REQUEST = 400
const ONCE = 1
const ONE_MESSAGE = 1
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

const makeAdapter = () =>
  new LarkAdapter({
    appId: 'test-app-id',
    appSecret: 'test-app-secret',
  })

const makeMockChat = () => ({
  getLogger: () => ({
    debug: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
  }),
  getState: vi.fn(),
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
})

const initAdapter = async (adapter: LarkAdapter) => {
  const mockChat = makeMockChat()
  server.use(tokenHandler, botInfoHandler, createCardHandler)
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
  // -- 7A: Thread ID encoding --
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

  // -- 7B: Webhook handling --
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

    it('deduplicates events by event_id', async () => {
      const adapter = makeAdapter()
      const mockChat = await initAdapter(adapter)

      const event = makeMessageEvent()
      const promises: Array<Promise<unknown>> = []
      const options = {
        waitUntil: (task: Promise<unknown>) => {
          promises.push(task)
        },
      }

      expect((await adapter.handleWebhook(makeRequest(event), options)).status).toBe(HTTP_OK)
      expect((await adapter.handleWebhook(makeRequest(event), options)).status).toBe(HTTP_OK)
      await Promise.allSettled(promises) // eslint-disable-line promise/avoid-new
      expect(mockChat.processMessage).toHaveBeenCalledTimes(ONCE)
    })

    it('returns 200 immediately for normal events', async () => {
      const adapter = makeAdapter()
      await initAdapter(adapter)

      const req = makeRequest(makeMessageEvent())
      expect((await adapter.handleWebhook(req)).status).toBe(HTTP_OK)
    })

    it('routes reaction event to processReaction', async () => {
      const adapter = makeAdapter()
      const mockChat = await initAdapter(adapter)

      const event = makeReactionEvent('created')
      const promises: Array<Promise<unknown>> = []
      const options = {
        waitUntil: (task: Promise<unknown>) => {
          promises.push(task)
        },
      }

      const res = await adapter.handleWebhook(makeRequest(event), options)
      expect(res.status).toBe(HTTP_OK)
      await Promise.allSettled(promises) // eslint-disable-line promise/avoid-new
      expect(mockChat.processReaction).toHaveBeenCalledTimes(ONCE)
    })
  })

  // -- 7C: Message parsing --
  describe('parseMessage', () => {
    let adapter = undefined as unknown as LarkAdapter

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
  })

  // -- 7D: Message sending --
  describe('message sending', () => {
    let adapter = undefined as unknown as LarkAdapter

    beforeEach(async () => {
      adapter = makeAdapter()
      await initAdapter(adapter)
    })

    it('postMessage sends text to chat', async () => {
      let captured = undefined as unknown
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
      let replyTo = undefined as unknown
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
      let editedId = undefined as unknown
      server.use(
        tokenHandler,
        http.patch(`${BASE}/open-apis/im/v1/messages/:id`, ({ params }) => {
          editedId = params['id']
          return HttpResponse.json({ code: 0 })
        }),
      )
      const threadId = adapter.encodeThreadId({ chatId: 'oc_chat001' })
      await adapter.editMessage(threadId, 'om_edit1', 'updated text')
      expect(editedId).toBe('om_edit1')
    })

    it('deleteMessage calls delete API', async () => {
      let deletedId = undefined as unknown
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
      let captured = undefined as unknown
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

  // -- 7E: Reactions --
  describe('reactions', () => {
    let adapter = undefined as unknown as LarkAdapter

    beforeEach(async () => {
      adapter = makeAdapter()
      await initAdapter(adapter)
    })

    it('addReaction sends emoji type', async () => {
      let captured = undefined as unknown
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
      let captured = undefined as unknown
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
      let deletedReactionId = undefined as unknown
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

  // -- 7F: Fetch methods --
  describe('fetch methods', () => {
    let adapter = undefined as unknown as LarkAdapter

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
                { content: '{"text":"msg1"}', create_time: '1700000000000', message_id: 'om_1' },
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
                  content: '{"text":"fetched"}',
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

  // -- 7F: DM --
  describe('DM', () => {
    let adapter = undefined as unknown as LarkAdapter

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

  // -- 7F: Misc --
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

  // -- 7G: Streaming --
  describe('stream', () => {
    let adapter = undefined as unknown as LarkAdapter

    beforeEach(async () => {
      adapter = makeAdapter()
      await initAdapter(adapter)
    })

    it('creates streaming card, sends updates, then closes streaming', async () => {
      const streamUpdates: Array<{ content: string; sequence: number }> = []
      let settingsCaptured = undefined as unknown

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
      expect(streamUpdates[streamUpdates.length - ONCE].content).toBe('Hello World!')
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

  // -- 7H: Ephemeral --
  describe('ephemeral', () => {
    let adapter = undefined as unknown as LarkAdapter

    beforeEach(async () => {
      adapter = makeAdapter()
      await initAdapter(adapter)
    })

    it('postEphemeral sends to correct user', async () => {
      let captured = undefined as unknown
      server.use(
        tokenHandler,
        http.post(`${BASE}/open-apis/ephemeral/v1/send`, async ({ request }) => {
          captured = await request.json()
          return HttpResponse.json({ code: 0 })
        }),
      )
      const threadId = adapter.encodeThreadId({ chatId: 'oc_chat001' })
      const result = await adapter.postEphemeral(threadId, 'ou_user1', 'secret msg')
      expect(captured).toMatchObject({ chat_id: 'oc_chat001', open_id: 'ou_user1' })
      expect(result.usedFallback).toBe(false)
    })
  })
})
