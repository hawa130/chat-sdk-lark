/**
 * Integration tests following Chat SDK testing.mdx patterns.
 *
 * Uses a real Chat instance with createMemoryState() and routes
 * webhooks through chat.webhooks.lark() — not adapter.handleWebhook().
 */
import { HttpResponse, http } from 'msw'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { fixtures } from './fixtures.ts'
import { server } from './setup.ts'
import { createLarkTestContext } from './test-utils.ts'

const { makeDMEvent, makeMessageEvent, makeReactionEvent } = fixtures

const BASE = 'https://open.feishu.cn'
const TOKEN_URL = `${BASE}/open-apis/auth/v3/tenant_access_token/internal`

const tokenHandler = http.post(TOKEN_URL, () =>
  HttpResponse.json({ code: 0, expire: 7200, tenant_access_token: 'test-token' }),
)

beforeAll(() => server.listen({ onUnhandledRequest: 'bypass' }))
afterEach(() => server.resetHandlers())
afterAll(() => server.close())

describe('integration: Chat → Lark adapter pipeline', () => {
  it('mention: bot detects @mention and onNewMention fires', async () => {
    const ctx = createLarkTestContext({
      onMention: async () => {
        // Handler fires — captured by test-utils
      },
    })

    await ctx.sendWebhook(makeMessageEvent())

    expect(ctx.captured.mentionMessage).not.toBeNull()
    expect(ctx.captured.mentionMessage!.text).toContain('hello bot')
    expect(ctx.captured.mentionMessage!.isMention).toBe(true)
    expect(ctx.captured.mentionThread).not.toBeNull()
  })

  it('subscribe + follow-up: after subscribe(), subsequent messages trigger onSubscribedMessage', async () => {
    // Set up message send handler for thread.post()
    server.use(
      tokenHandler,
      http.post(`${BASE}/open-apis/im/v1/messages`, () =>
        HttpResponse.json({ code: 0, data: { message_id: 'om_reply' } }),
      ),
    )

    const ctx = createLarkTestContext({
      onMention: async (thread) => {
        await thread.subscribe()
      },
      onSubscribed: async () => {
        // Follow-up captured
      },
    })

    // Initialize explicitly to ensure adapter and state are ready
    await ctx.chat.initialize()

    // Send initial mention
    await ctx.sendWebhook(makeMessageEvent())
    expect(ctx.captured.mentionMessage).not.toBeNull()

    // Send follow-up in same chat (different event_id + message_id)
    const followUp = makeMessageEvent({
      event: {
        message: {
          chat_id: 'oc_chat001',
          chat_type: 'group',
          content: '{"text":"follow up message"}',
          create_time: '1700000000100',
          message_id: 'om_msg002',
          message_type: 'text',
        },
        sender: {
          sender_id: { open_id: 'ou_user1' },
          sender_type: 'user',
        },
      },
      header: {
        event_id: 'ev-002',
        event_type: 'im.message.receive_v1',
      },
    })

    await ctx.sendWebhook(followUp)
    expect(ctx.captured.subscribedMessage).not.toBeNull()
    expect(ctx.captured.subscribedMessage!.text).toBe('follow up message')
  })

  it('self-message filtering: messages from bot are not processed', async () => {
    const ctx = createLarkTestContext({
      onMention: async () => {
        // Should not fire for bot's own messages
      },
    })

    // Send a message from the bot itself (sender open_id = bot open_id)
    const botEvent = makeMessageEvent({
      event: {
        message: {
          chat_id: 'oc_chat001',
          chat_type: 'group',
          content: '{"text":"bot talking to itself"}',
          create_time: '1700000000000',
          mentions: [{ id: { open_id: 'ou_bot001' }, key: '@_user_1', name: 'TestBot' }],
          message_id: 'om_bot_self',
          message_type: 'text',
        },
        sender: {
          sender_id: { open_id: 'ou_bot001' },
          sender_type: 'bot',
        },
      },
      header: {
        event_id: 'ev-self',
        event_type: 'im.message.receive_v1',
      },
    })

    await ctx.sendWebhook(botEvent)
    expect(ctx.captured.mentionMessage).toBeNull()
  })

  it('DM flow: direct messages are detected and routed correctly', async () => {
    const ctx = createLarkTestContext({
      onDM: async () => {
        // DM handler fires
      },
    })

    await ctx.sendWebhook(makeDMEvent())

    expect(ctx.captured.dmMessage).not.toBeNull()
    expect(ctx.captured.dmMessage!.text).toContain('hi bot')
    expect(ctx.captured.dmThread).not.toBeNull()
  })

  it('reaction: emoji reaction fires onReaction with correct data', async () => {
    server.use(
      tokenHandler,
      http.get(`${BASE}/open-apis/im/v1/messages/:message_id`, () =>
        HttpResponse.json({
          code: 0,
          data: {
            items: [{ chat_id: 'oc_chat001', message_id: 'om_msg001', root_id: '' }],
          },
        }),
      ),
    )

    let capturedEmoji = ''
    let capturedAdded: boolean | undefined

    const ctx = createLarkTestContext({
      onReaction: async (event) => {
        capturedEmoji = event.rawEmoji
        capturedAdded = event.added
      },
    })

    await ctx.chat.initialize()
    await ctx.sendWebhook(makeReactionEvent('created'))

    // Wait for async threadId resolution before assertion
    await vi.waitFor(() => {
      expect(capturedEmoji).toBe('THUMBSUP')
    })
    expect(capturedAdded).toBe(true)
  })

  it('rate limit: API 429 propagates AdapterRateLimitError', async () => {
    server.use(
      tokenHandler,
      http.post(`${BASE}/open-apis/im/v1/messages`, () => new HttpResponse(null, { status: 429 })),
    )

    const ctx = createLarkTestContext()
    // Must initialize before calling adapter methods directly
    await ctx.chat.initialize()
    const threadId = ctx.adapter.encodeThreadId({ chatId: 'oc_chat001' })
    await expect(ctx.adapter.postMessage(threadId, 'hello')).rejects.toMatchObject({
      name: 'AdapterRateLimitError',
    })
  })

  it('deduplication: same event_id sent twice only fires handler once', async () => {
    let mentionCount = 0

    const ctx = createLarkTestContext({
      onMention: async () => {
        mentionCount++
      },
    })

    const event = makeMessageEvent()
    await ctx.sendWebhook(event)
    await ctx.sendWebhook(event)

    const ONCE = 1
    expect(mentionCount).toBe(ONCE)
  })
})
