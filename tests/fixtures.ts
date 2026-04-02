import { createHash } from 'node:crypto'

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

/** Helper: create a signed Request for Encrypt Key validation. */
const makeSignedRequest = (
  body: unknown,
  encryptKey: string,
  { nonce = 'test-nonce', timestamp = '1700000000' }: { nonce?: string; timestamp?: string } = {},
): Request => {
  const rawBody = JSON.stringify(body)
  const signature = createHash('sha256')
    .update(`${timestamp}${nonce}${encryptKey}${rawBody}`)
    .digest('hex')

  return new Request('http://localhost/webhook', {
    body: rawBody,
    headers: {
      'content-type': 'application/json',
      'x-lark-request-nonce': nonce,
      'x-lark-signature': signature,
      'x-lark-request-timestamp': timestamp,
    },
    method: 'POST',
  })
}

/** Card action callback (card.action.trigger). */
const makeCardActionEvent = (actionId = 'approve', value = 'order_123') => ({
  event: {
    action: {
      tag: 'button',
      value: { action: value, id: actionId },
    },
    context: {
      open_chat_id: 'oc_chat001',
      open_message_id: 'om_card_msg001',
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
  event: {
    action: {
      option,
      tag: 'select_static',
      value: { id: actionId },
    },
    context: {
      open_chat_id: 'oc_chat001',
      open_message_id: 'om_card_msg002',
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

/** Modal form submit callback (card.action.trigger with form_value). */
const makeModalSubmitEvent = (
  callbackId = 'feedback_form',
  formValues: Record<string, string> = { message: 'Great!', category: 'general' },
  contextId = 'ctx_123',
  privateMetadata?: string,
) => ({
  event: {
    action: {
      form_action_type: 'submit',
      form_value: formValues,
      name: 'submit_btn',
      tag: 'button',
      value: {
        __callbackId: callbackId,
        __contextId: contextId,
        __modal: '1',
        ...(privateMetadata ? { __privateMetadata: privateMetadata } : {}),
      },
    },
    context: {
      open_chat_id: 'oc_chat001',
      open_message_id: 'om_form_msg001',
    },
    operator: { open_id: 'ou_user1' },
    token: 'c-form-token-001',
  },
  header: {
    app_id: 'test-app-id',
    create_time: '1700000000000',
    event_id: 'ev-form-submit-001',
    event_type: 'card.action.trigger',
    tenant_key: 'test-tenant',
    token: 'test-verification-token',
  },
  schema: '2.0',
})

/** Modal form reset/cancel callback. */
const makeModalResetEvent = (callbackId = 'feedback_form') => ({
  event: {
    action: {
      form_action_type: 'reset',
      tag: 'button',
      value: {
        __callbackId: callbackId,
        __contextId: 'ctx_123',
        __modal: '1',
      },
    },
    context: {
      open_chat_id: 'oc_chat001',
      open_message_id: 'om_form_msg001',
    },
    operator: { open_id: 'ou_user1' },
    token: 'c-form-token-002',
  },
  header: {
    app_id: 'test-app-id',
    create_time: '1700000000000',
    event_id: 'ev-form-reset-001',
    event_type: 'card.action.trigger',
    tenant_key: 'test-tenant',
    token: 'test-verification-token',
  },
  schema: '2.0',
})

/** Modal fallback close callback (separate from reset). */
const makeModalCloseEvent = (
  callbackId = 'feedback_form',
  contextId = 'ctx_123',
  privateMetadata?: string,
  notifyOnClose = true,
  modalTitle = 'Feedback',
) => ({
  event: {
    action: {
      tag: 'button',
      value: {
        __callbackId: callbackId,
        __contextId: contextId,
        __modal: '1',
        __modalClose: '1',
        __modalTitle: modalTitle,
        ...(notifyOnClose ? { __notifyOnClose: '1' } : {}),
        ...(privateMetadata ? { __privateMetadata: privateMetadata } : {}),
      },
    },
    context: {
      open_chat_id: 'oc_chat001',
      open_message_id: 'om_form_msg001',
    },
    operator: { open_id: 'ou_user1' },
    token: 'c-form-token-003',
  },
  header: {
    app_id: 'test-app-id',
    create_time: '1700000000000',
    event_id: 'ev-form-close-001',
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
  makeModalCloseEvent,
  makeModalResetEvent,
  makeModalSubmitEvent,
  makeReactionEvent,
  makeRequest,
  makeSignedRequest,
  makeSelectActionEvent,
}

export { fixtures }
