import { HttpResponse, http } from 'msw'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import LarkApiClient from '../src/api-client.ts'
import server from './setup.ts'

const BASE = 'https://open.feishu.cn'
const TOKEN_URL = `${BASE}/open-apis/auth/v3/tenant_access_token/internal`

const tokenHandler = http.post(TOKEN_URL, () =>
  HttpResponse.json({ code: 0, expire: 7200, tenant_access_token: 'test-token' }),
)

const makeClient = () => new LarkApiClient({ appId: 'app-id', appSecret: 'app-secret' })

beforeAll(() => server.listen({ onUnhandledRequest: 'bypass' }))
afterEach(() => server.resetHandlers())
afterAll(() => server.close())

describe('LarkApiClient', () => {
  it('sendMessage — sends text with correct params', async () => {
    let captured: unknown = undefined
    server.use(
      tokenHandler,
      http.post(`${BASE}/open-apis/im/v1/messages`, async ({ request }) => {
        captured = await request.json()
        return HttpResponse.json({ code: 0, data: { message_id: 'om_123' } })
      }),
    )

    const client = makeClient()
    const result = await client.sendMessage('oc_chat1', 'text', '{"text":"hello"}')

    expect(captured).toMatchObject({
      content: '{"text":"hello"}',
      msg_type: 'text',
      receive_id: 'oc_chat1',
    })
    expect(result).toMatchObject({ data: { message_id: 'om_123' } })
  })

  it('replyMessage — replies to message', async () => {
    let captured: unknown = undefined
    server.use(
      tokenHandler,
      http.post(`${BASE}/open-apis/im/v1/messages/:id/reply`, async ({ params, request }) => {
        captured = { body: await request.json(), id: params['id'] }
        return HttpResponse.json({ code: 0, data: { message_id: 'om_reply' } })
      }),
    )

    const client = makeClient()
    const result = await client.replyMessage('om_parent', 'text', '{"text":"reply"}')

    expect(captured).toMatchObject({
      body: { content: '{"text":"reply"}', msg_type: 'text' },
      id: 'om_parent',
    })
    expect(result).toMatchObject({ data: { message_id: 'om_reply' } })
  })

  it('updateMessage — patches message content', async () => {
    let captured: unknown = undefined
    server.use(
      tokenHandler,
      http.patch(`${BASE}/open-apis/im/v1/messages/:id`, async ({ params, request }) => {
        captured = { body: await request.json(), id: params['id'] }
        return HttpResponse.json({ code: 0 })
      }),
    )

    const client = makeClient()
    await client.updateMessage('om_msg1', 'text', '{"text":"updated"}')

    expect(captured).toMatchObject({
      body: { content: '{"text":"updated"}' },
      id: 'om_msg1',
    })
  })

  it('deleteMessage — deletes message', async () => {
    let deletedId: string | readonly string[] | undefined = undefined
    server.use(
      tokenHandler,
      http.delete(`${BASE}/open-apis/im/v1/messages/:id`, ({ params }) => {
        deletedId = params['id']
        return HttpResponse.json({ code: 0 })
      }),
    )

    const client = makeClient()
    await client.deleteMessage('om_del1')

    expect(deletedId).toBe('om_del1')
  })

  it('getMessage — fetches single message', async () => {
    server.use(
      tokenHandler,
      http.get(`${BASE}/open-apis/im/v1/messages/:id`, ({ params }) =>
        HttpResponse.json({
          code: 0,
          data: { items: [{ content: '{"text":"hi"}', message_id: params['id'] }] },
        }),
      ),
    )

    const client = makeClient()
    const result = await client.getMessage('om_fetch1')

    expect(result).toMatchObject({ data: { items: [{ message_id: 'om_fetch1' }] } })
  })

  it('listMessages — lists with pagination', async () => {
    const pageSize = 10
    let capturedParams: URLSearchParams | undefined = undefined
    server.use(
      tokenHandler,
      http.get(`${BASE}/open-apis/im/v1/messages`, ({ request }) => {
        capturedParams = new URL(request.url).searchParams
        return HttpResponse.json({
          code: 0,
          data: { has_more: true, items: [], page_token: 'next-page' },
        })
      }),
    )

    const client = makeClient()
    const result = await client.listMessages('oc_chat1', 'tok_abc', pageSize)

    expect(capturedParams?.get('container_id')).toBe('oc_chat1')
    expect(capturedParams?.get('container_id_type')).toBe('chat')
    expect(capturedParams?.get('page_token')).toBe('tok_abc')
    expect(capturedParams?.get('page_size')).toBe(String(pageSize))
    expect(result).toMatchObject({ data: { has_more: true } })
  })

  it('getBotInfo — returns bot info', async () => {
    server.use(
      tokenHandler,
      http.get(`${BASE}/open-apis/bot/v3/info`, () =>
        HttpResponse.json({
          bot: { app_name: 'TestBot', open_id: 'ou_bot1' },
          code: 0,
        }),
      ),
    )

    const client = makeClient()
    const result = await client.getBotInfo()

    expect(result).toMatchObject({ bot: { app_name: 'TestBot', open_id: 'ou_bot1' } })
  })

  it('429 response → throws AdapterRateLimitError', async () => {
    server.use(
      tokenHandler,
      http.post(`${BASE}/open-apis/im/v1/messages`, () => new HttpResponse(null, { status: 429 })),
    )

    const client = makeClient()
    await expect(client.sendMessage('oc_chat1', 'text', '{"text":"hi"}')).rejects.toMatchObject({
      name: 'AdapterRateLimitError',
    })
  })
})
