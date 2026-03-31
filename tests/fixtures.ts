/** A minimal im.message.receive_v1 event payload (v2 schema). */
const makeMessageEvent = (overrides?: Record<string, unknown>) => ({
  event: {
    message: {
      chat_id: 'oc_chat001',
      chat_type: 'group',
      content: '{"text":"@_user_1 hello bot"}',
      create_time: '1700000000000',
      mentions: [
        {
          id: { open_id: 'ou_bot001' },
          key: '@_user_1',
          name: 'TestBot',
        },
      ],
      message_id: 'om_msg001',
      message_type: 'text',
      parent_id: '',
      root_id: '',
    },
    sender: {
      sender_id: { open_id: 'ou_user1', union_id: 'un1', user_id: 'uid1' },
      sender_type: 'user',
      tenant_key: 'test-tenant',
    },
  },
  header: {
    app_id: 'test-app-id',
    create_time: '1700000000000',
    event_id: 'ev-001',
    event_type: 'im.message.receive_v1',
    tenant_key: 'test-tenant',
    token: 'test-verification-token',
  },
  schema: '2.0',
  ...overrides,
})

/** A DM message event. */
const makeDMEvent = () =>
  makeMessageEvent({
    event: {
      message: {
        chat_id: 'oc_dm001',
        chat_type: 'p2p',
        content: '{"text":"hi bot"}',
        create_time: '1700000000000',
        message_id: 'om_dm001',
        message_type: 'text',
      },
      sender: {
        sender_id: { open_id: 'ou_user1' },
        sender_type: 'user',
      },
    },
  })

/** Reaction event. */
const makeReactionEvent = (type: 'created' | 'deleted' = 'created') => ({
  event: {
    action_time: '1700000000000',
    message_id: 'om_msg001',
    operator_type: 'user',
    reaction_type: { emoji_type: 'THUMBSUP' },
    user_id: { open_id: 'ou_user1' },
  },
  header: {
    app_id: 'test-app-id',
    create_time: '1700000000000',
    event_id: `ev-reaction-${type}`,
    event_type: `im.message.reaction.${type}_v1`,
    tenant_key: 'test-tenant',
    token: 'test-verification-token',
  },
  schema: '2.0',
})

/** URL verification challenge payload. */
const makeChallengeEvent = (challenge = 'test-challenge-value') => ({
  challenge,
  token: 'test-verification-token',
  type: 'url_verification',
})

/** Helper: create a Request from a JSON body. */
const makeRequest = (body: unknown): Request =>
  new Request('http://localhost/webhook', {
    body: JSON.stringify(body),
    headers: { 'content-type': 'application/json' },
    method: 'POST',
  })

/** Card action callback (card.action.trigger). */
const makeCardActionEvent = (actionId = 'approve', value = 'order_123') => ({
  context: {
    open_chat_id: 'oc_chat001',
    open_message_id: 'om_card_msg001',
  },
  event: {
    action: {
      tag: 'button',
      value: { action: value, id: actionId },
    },
    operator: { open_id: 'ou_user1', union_id: 'un1' },
    token: 'c-card-token-001',
  },
  header: {
    app_id: 'test-app-id',
    create_time: '1700000000000',
    event_id: 'ev-card-action-001',
    event_type: 'card.action.trigger',
    tenant_key: 'test-tenant',
    token: 'test-verification-token',
  },
  schema: '2.0',
})

/** Card select action callback. */
const makeSelectActionEvent = (actionId = 'priority', option = 'high') => ({
  context: {
    open_chat_id: 'oc_chat001',
    open_message_id: 'om_card_msg002',
  },
  event: {
    action: {
      option,
      tag: 'select_static',
      value: { id: actionId },
    },
    operator: { open_id: 'ou_user1' },
    token: 'c-card-token-002',
  },
  header: {
    app_id: 'test-app-id',
    create_time: '1700000000000',
    event_id: 'ev-card-select-001',
    event_type: 'card.action.trigger',
    tenant_key: 'test-tenant',
    token: 'test-verification-token',
  },
  schema: '2.0',
})

const fixtures = {
  makeCardActionEvent,
  makeChallengeEvent,
  makeDMEvent,
  makeMessageEvent,
  makeReactionEvent,
  makeRequest,
  makeSelectActionEvent,
}

export { fixtures }
