import type { Domain } from '@larksuiteoapi/node-sdk'

/** Thread identifier for Lark — encodes a chat and optional root message (for thread replies). */
interface LarkThreadId {
  chatId: string
  rootMessageId?: string
}

interface LarkAdapterConfig {
  /** Lark app ID (or env LARK_APP_ID) */
  appId: string
  /** Lark app secret (or env LARK_APP_SECRET) */
  appSecret: string
  /** Encrypt key for event decryption (or env LARK_ENCRYPT_KEY) */
  encryptKey?: string
  /** Verification token for v1 events (or env LARK_VERIFICATION_TOKEN) */
  verificationToken?: string
  /** API domain — lark.Domain.Feishu (default) or lark.Domain.Lark */
  domain?: Domain | string
  /** Bot display name (defaults to name from bot info API) */
  userName?: string
  /** Disable SDK's internal token cache */
  disableTokenCache?: boolean
}

/** Raw event data from im.message.receive_v1, as delivered by the SDK's EventDispatcher. */
interface LarkRawMessage {
  event_id?: string
  sender: {
    sender_id?: {
      union_id?: string
      user_id?: string
      open_id?: string
    }
    sender_type: string
    tenant_key?: string
  }
  message: {
    message_id: string
    root_id?: string
    parent_id?: string
    create_time: string
    update_time?: string
    chat_id: string
    thread_id?: string
    chat_type: string
    message_type: string
    content: string
    mentions?: Array<{
      key: string
      id: { union_id?: string; user_id?: string; open_id?: string }
      name: string
      tenant_key?: string
    }>
  }
}

/** Message item from Lark REST API (im/v1/messages list/get). */
interface LarkMessageItem {
  message_id?: string
  root_id?: string
  parent_id?: string
  thread_id?: string
  msg_type?: string
  create_time?: string
  update_time?: string
  deleted?: boolean
  updated?: boolean
  chat_id?: string
  sender?: {
    id: string
    id_type: string
    sender_type: string
    tenant_key?: string
  }
  body?: {
    content: string
  }
  mentions?: Array<{
    key: string
    id: string
    id_type: string
    name: string
    tenant_key?: string
  }>
  upper_message_id?: string
}

/** Tracks a CardKit card entity for streaming and updates. */
interface CardKitCard {
  cardId: string
  elementId: string
}

/**
 * Union of all raw platform data that can appear in Message.raw or RawMessage.raw.
 *
 * - `LarkRawMessage` — webhook event payload from im.message.receive_v1
 * - `LarkMessageItem` — REST API response item from message get/list/create/reply/update
 */
type LarkRaw = LarkRawMessage | LarkMessageItem

/** File types accepted by Lark's im/v1/files upload API. */
type LarkFileType = 'doc' | 'mp4' | 'opus' | 'pdf' | 'ppt' | 'stream' | 'xls'

// ---------------------------------------------------------------------------
// Card JSON 2.0 types (based on official Lark card component docs)
// ---------------------------------------------------------------------------

interface LarkPlainText {
  tag: 'plain_text'
  content: string
}

interface LarkMarkdownElement {
  tag: 'markdown'
  content: string | undefined
  element_id: string
  text_align?: 'left' | 'center' | 'right'
}

interface LarkHrElement {
  tag: 'hr'
  element_id: string
}

interface LarkImgElement {
  tag: 'img'
  img_key: string | undefined
  alt: LarkPlainText
  element_id: string
}

interface LarkButtonElement {
  tag: 'button'
  text: LarkPlainText
  type: string
  element_id: string
  behaviors: LarkBehavior[]
  disabled?: boolean
}

interface LarkSelectElement {
  tag: 'select_static'
  element_id: string
  options: Array<{ text: LarkPlainText; value: string }>
  behaviors: LarkBehavior[]
  placeholder?: LarkPlainText
  initial_option?: string
}

interface LarkColumn {
  tag: 'column'
  elements: LarkCardElement[]
  width: string
  weight?: number
  vertical_align?: string
}

interface LarkColumnSetElement {
  tag: 'column_set'
  columns: LarkColumn[]
  flex_mode?: string
  background_style?: string
}

interface LarkTableElement {
  tag: 'table'
  element_id: string
  columns: Array<{
    data_type: 'text'
    display_name: string
    horizontal_align: string
    name: string
  }>
  rows: Array<Record<string, string>>
  header_style?: { bold: boolean; text_align: string }
  page_size?: number
}

type LarkCardElement =
  | LarkButtonElement
  | LarkColumnSetElement
  | LarkHrElement
  | LarkImgElement
  | LarkMarkdownElement
  | LarkSelectElement
  | LarkTableElement

type LarkBehavior =
  | { type: 'callback'; value: Record<string, string> }
  | { type: 'open_url'; default_url: string }

interface LarkCardHeader {
  title: LarkPlainText
  subtitle?: LarkPlainText
  template: string
}

interface LarkCardBody {
  schema: '2.0'
  config: { streaming_mode?: boolean; update_multi: true }
  header?: LarkCardHeader
  body: { elements: LarkCardElement[] }
}

// ---------------------------------------------------------------------------
// Message content types (JSON-parsed message body)
// ---------------------------------------------------------------------------

interface LarkTextContent {
  text: string
}

interface LarkPostContent {
  post: Record<
    string,
    { content?: Array<Array<{ tag: string; [key: string]: unknown }>>; title?: string }
  >
}

interface LarkInteractiveContent {
  body: { elements: Array<{ tag: string; content?: string }> }
}

type LarkMessageContent = LarkInteractiveContent | LarkPostContent | LarkTextContent

// ---------------------------------------------------------------------------
// Webhook event envelope (v2 schema)
// ---------------------------------------------------------------------------

interface LarkWebhookBody {
  header?: { event_id?: string; event_type?: string }
  type?: string
}

// ---------------------------------------------------------------------------
// SDK error shape (Axios-based)
// ---------------------------------------------------------------------------

interface LarkSdkError {
  code?: number
  httpCode?: number
  message?: string
  response?: {
    data?: { code?: number; msg?: string }
    status?: number
  }
  status?: number
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

export type {
  CardKitCard,
  LarkAdapterConfig,
  LarkBehavior,
  LarkButtonElement,
  LarkCardBody,
  LarkCardElement,
  LarkCardHeader,
  LarkColumnSetElement,
  LarkFileType,
  LarkHrElement,
  LarkImgElement,
  LarkInteractiveContent,
  LarkMarkdownElement,
  LarkMessageContent,
  LarkMessageItem,
  LarkPostContent,
  LarkRaw,
  LarkRawMessage,
  LarkSdkError,
  LarkSelectElement,
  LarkTableElement,
  LarkTextContent,
  LarkThreadId,
  LarkWebhookBody,
}
