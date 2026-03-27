import { HttpResponse, http } from 'msw'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import LarkAdapter from '../src/adapter.ts'
import fixtures from './fixtures.ts'
import server from './setup.ts'

const { makeDMEvent, makeMessageEvent, makeRequest } = fixtures

const BASE = 'https://open.feishu.cn'
const TOKEN_URL = `${BASE}/open-apis/auth/v3/tenant_access_token/internal`
const FIRST_CALL = 0
const THREAD_ID_SEGMENT_COUNT = 3
const LAST_INDEX_OFFSET = 1

const tokenHandler = http.post(TOKEN_URL, () =>
  HttpResponse.json({ code: 0, expire: 7200, tenant_access_token: 'test-token' }),
)

const botInfoHandler = http.get(`${BASE}/open-apis/bot/v3/info`, () =>
  HttpResponse.json({ bot: { app_name: 'TestBot', open_id: 'ou_bot001' }, code: 0 }),
)

const createCardHandler = http.post(`${BASE}/open-apis/cardkit/v1/cards`, () =>
  HttpResponse.json({ code: 0, data: { card_id: 'card_int_001' } }),
)

const makeAdapter = () => new LarkAdapter({ appId: 'test-app-id', appSecret: 'test-app-secret' })

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

/**
 * Sends an event to the adapter via handleWebhook and waits for async processing.
 * Uses waitUntil to capture and await the event processing promise.
 */
const sendEvent = async (adapter: LarkAdapter, body: unknown): Promise<void> => {
  const promises: Array<Promise<unknown>> = []
  const options = {
    waitUntil: (task: Promise<unknown>) => {
      promises.push(task)
    },
  }
  await adapter.handleWebhook(makeRequest(body), options)
  await Promise.allSettled(promises) // eslint-disable-line promise/avoid-new
}

const initAdapter = async (adapter: LarkAdapter) => {
  const mockChat = makeMockChat()
  server.use(tokenHandler, botInfoHandler, createCardHandler)
  await adapter.initialize(mockChat as never)
  return mockChat
}

const getFirstProcessMessageCall = (
  mockChat: ReturnType<typeof makeMockChat>,
): [unknown, string, { isMention: boolean; text: string }] =>
  mockChat.processMessage.mock.calls[FIRST_CALL] as [
    unknown,
    string,
    { isMention: boolean; text: string },
  ]

const makeThreadReplyEvent = () =>
  makeMessageEvent({
    event: {
      message: {
        chat_id: 'oc_chat001',
        chat_type: 'group',
        content: '{"text":"@_user_1 reply in thread"}',
        create_time: '1700000000001',
        mentions: [{ id: { open_id: 'ou_bot001' }, key: '@_user_1', name: 'TestBot' }],
        message_id: 'om_thread1',
        message_type: 'text',
        parent_id: 'om_root1',
        root_id: 'om_root1',
      },
      sender: {
        sender_id: { open_id: 'ou_user1' },
        sender_type: 'user',
        tenant_key: 'test-tenant',
      },
    },
  })

const assertProcessMessageCalledWithMention = (
  adapter: LarkAdapter,
  mockChat: ReturnType<typeof makeMockChat>,
): string => {
  expect(mockChat.processMessage).toHaveBeenCalledOnce()
  const [calledAdapter, threadId, message] = getFirstProcessMessageCall(mockChat)
  expect(calledAdapter).toBe(adapter)
  expect(threadId).toMatch(/^lark:/)
  expect(message.isMention).toBe(true)
  return threadId
}

const makeStreamChunks = async function* streamChunks() {
  yield 'Hello'
  yield ' world'
  yield '!'
}

beforeAll(() => server.listen({ onUnhandledRequest: 'bypass' }))
afterEach(() => server.resetHandlers())
afterAll(() => server.close())

describe('integration', () => {
  // -- Full send/receive flow --
  it('full send/receive: webhook event triggers processMessage and posts reply', async () => {
    const adapter = makeAdapter()
    const mockChat = await initAdapter(adapter)
    let postedBody: unknown = undefined

    server.use(
      tokenHandler,
      http.post(`${BASE}/open-apis/im/v1/messages`, async ({ request }) => {
        postedBody = await request.json()
        return HttpResponse.json({ code: 0, data: { message_id: 'om_reply1' } })
      }),
    )

    await sendEvent(adapter, makeMessageEvent())
    const threadId = assertProcessMessageCalledWithMention(adapter, mockChat)
    await adapter.postMessage(threadId, 'hello back')
    expect(postedBody).toMatchObject({ msg_type: 'text', receive_id: 'oc_chat001' })
  })

  // -- Thread reply flow --
  it('thread reply: event with root_id causes replyMessage to be used', async () => {
    const adapter = makeAdapter()
    const mockChat = await initAdapter(adapter)
    let repliedToId: string | readonly string[] | undefined = undefined

    await sendEvent(adapter, makeThreadReplyEvent())
    expect(mockChat.processMessage).toHaveBeenCalledOnce()

    const [, threadId] = getFirstProcessMessageCall(mockChat)
    expect(threadId.split(':')).toHaveLength(THREAD_ID_SEGMENT_COUNT)

    server.use(
      tokenHandler,
      http.post(`${BASE}/open-apis/im/v1/messages/:id/reply`, ({ params }) => {
        repliedToId = params['id']
        return HttpResponse.json({ code: 0, data: { message_id: 'om_threaded_reply' } })
      }),
    )

    await adapter.postMessage(threadId, 'threaded reply')
    expect(repliedToId).toBe('om_root1')
  })

  // -- Streaming E2E --
  it('streaming: creates card entity, streams text, closes streaming mode', async () => {
    const adapter = makeAdapter()
    await initAdapter(adapter)
    const streamUpdates: string[] = []

    server.use(
      tokenHandler,
      createCardHandler,
      http.post(`${BASE}/open-apis/im/v1/messages`, () =>
        HttpResponse.json({ code: 0, data: { message_id: 'om_stream1' } }),
      ),
      http.put(
        `${BASE}/open-apis/cardkit/v1/cards/:cardId/elements/:elementId/content`,
        async ({ request }) => {
          const body = (await request.json()) as { content: string }
          streamUpdates.push(body.content)
          return HttpResponse.json({ code: 0, data: {} })
        },
      ),
      http.patch(`${BASE}/open-apis/cardkit/v1/cards/:cardId/settings`, () =>
        HttpResponse.json({ code: 0, data: {} }),
      ),
    )

    const threadId = adapter.encodeThreadId({ chatId: 'oc_chat001' })
    const result = await adapter.stream(threadId, makeStreamChunks())
    expect(result.id).toBe('om_stream1')
    expect(streamUpdates[streamUpdates.length - LAST_INDEX_OFFSET]).toContain('Hello world!')
  })

  // -- Event deduplication --
  it('deduplication: same event_id sent twice calls processMessage only once', async () => {
    const adapter = makeAdapter()
    const mockChat = await initAdapter(adapter)

    const event = makeMessageEvent({
      header: { event_id: 'ev-dedup-001', event_type: 'im.message.receive_v1' },
    })

    await sendEvent(adapter, event)
    await sendEvent(adapter, event)

    expect(mockChat.processMessage).toHaveBeenCalledOnce()
  })

  // -- DM flow --
  it('DM flow: p2p event sets isMention=true; openDM makes isDM return true', async () => {
    const adapter = makeAdapter()
    const mockChat = await initAdapter(adapter)

    await sendEvent(adapter, makeDMEvent())
    expect(mockChat.processMessage).toHaveBeenCalledOnce()

    const [, , message] = getFirstProcessMessageCall(mockChat)
    expect(message.isMention).toBe(true)

    server.use(
      tokenHandler,
      http.post(`${BASE}/open-apis/im/v1/chats`, () =>
        HttpResponse.json({ code: 0, data: { chat_id: 'oc_dm_new' } }),
      ),
    )
    const dmThreadId = await adapter.openDM('ou_user2')
    expect(adapter.isDM(dmThreadId)).toBe(true)
  })

  // -- Rate limit handling --
  it('rate limit: API returns 429 → postMessage throws AdapterRateLimitError', async () => {
    const adapter = makeAdapter()
    await initAdapter(adapter)

    server.use(
      tokenHandler,
      http.post(`${BASE}/open-apis/im/v1/messages`, () => new HttpResponse(null, { status: 429 })),
    )

    const threadId = adapter.encodeThreadId({ chatId: 'oc_chat001' })
    await expect(adapter.postMessage(threadId, 'hello')).rejects.toMatchObject({
      name: 'AdapterRateLimitError',
    })
  })

  // -- openDM creates chat --
  it('openDM: calls create chat API and isDM returns true for new thread', async () => {
    const adapter = makeAdapter()
    await initAdapter(adapter)
    let capturedBody: unknown = undefined

    server.use(
      tokenHandler,
      http.post(`${BASE}/open-apis/im/v1/chats`, async ({ request }) => {
        capturedBody = await request.json()
        return HttpResponse.json({ code: 0, data: { chat_id: 'oc_dm_created' } })
      }),
    )

    const threadId = await adapter.openDM('ou_target_user')
    expect(capturedBody).toMatchObject({ user_id_list: ['ou_target_user'] })
    expect(adapter.isDM(threadId)).toBe(true)
    expect(adapter.channelIdFromThreadId(threadId)).toBe('oc_dm_created')
  })
})
