import type { AppType, Cache, Domain, HttpInstance } from '@larksuiteoapi/node-sdk'
import type { Logger } from 'chat'

interface LarkThreadId {
  chatId: string
  threadId?: string
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
  /** API domain — Domain.Feishu (default) or Domain.Lark for international */
  domain?: Domain | string
  /** Bot display name (defaults to name from bot info API) */
  userName?: string
  /** Disable SDK's internal token cache */
  disableTokenCache?: boolean
  /** Custom logger instance (defaults to ConsoleLogger) */
  logger?: Logger
  /** App type — AppType.SelfBuild (default) or AppType.ISV for marketplace apps */
  appType?: AppType
  /** Custom token cache (e.g. Redis) for distributed deployments */
  cache?: Cache
  /** Custom HTTP client instance for proxy, timeout, or interceptor support */
  httpInstance?: HttpInstance
  /** Custom summary text shown in chat list during card streaming (defaults to Lark's "[生成中...]") */
  streamingSummary?: string
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

type LarkFileType = 'doc' | 'mp4' | 'opus' | 'pdf' | 'ppt' | 'stream' | 'xls'

// ---------------------------------------------------------------------------
// Card child (Chat SDK input shape)
// ---------------------------------------------------------------------------

/** Minimal shapes for card elements (JSX components, not importable as types). */
interface CardChild {
  align?: string[]
  alt?: string
  children?: CardChild[]
  content?: string
  disabled?: boolean
  headers?: string[]
  id?: string
  imageUrl?: string
  initialOption?: string
  label?: string
  options?: CardChild[]
  placeholder?: string
  rows?: string[][]
  style?: string
  subtitle?: string
  title?: string
  type: string
  url?: string
  value?: string
}

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
  form_action_type?: 'submit' | 'reset'
  name?: string
}

interface LarkSelectElement {
  tag: 'select_static'
  element_id: string
  options: Array<{ text: LarkPlainText; value: string }>
  behaviors: LarkBehavior[]
  placeholder?: LarkPlainText
  initial_option?: string
  name?: string
  required?: boolean
  width?: string
}

/** Lark input element for form containers (card JSON 2.0). */
interface LarkInputElement {
  tag: 'input'
  element_id: string
  name: string
  required?: boolean
  placeholder?: LarkPlainText
  default_value?: string
  label?: LarkPlainText
  label_position?: 'top' | 'left'
  input_type?: 'text' | 'multiline_text' | 'password'
  max_length?: number
  width?: string
}

/** Lark form container element (card JSON 2.0). */
interface LarkFormElement {
  tag: 'form'
  name: string
  elements: LarkCardElement[]
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
  | LarkFormElement
  | LarkHrElement
  | LarkImgElement
  | LarkInputElement
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
  config: { streaming_mode?: boolean; summary?: { content: string }; update_multi: true }
  header?: LarkCardHeader
  body: { elements: LarkCardElement[] }
}

// ---------------------------------------------------------------------------
// Message content types (JSON-parsed message body)
// ---------------------------------------------------------------------------

interface LarkTextContent {
  text: string
}

interface LarkImageContent {
  image_key: string
}

interface LarkFileContent {
  file_key: string
  file_name: string
}

interface LarkAudioContent {
  file_key: string
  duration: number
}

interface LarkMediaContent {
  file_key: string
  image_key: string
  file_name: string
  duration: number
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

/**
 * card.action.trigger callback (v2 schema).
 * NOT handled by EventDispatcher — routed at the webhook level.
 */
interface LarkCardActionBody extends LarkWebhookBody {
  event?: {
    operator?: { open_id?: string; union_id?: string; user_id?: string; tenant_key?: string }
    token?: string
    action?: {
      tag?: string
      value?: Record<string, string>
      option?: string
      input_value?: string
      form_value?: Record<string, string | string[]>
      name?: string
      form_action_type?: string
    }
    host?: string
    context?: {
      open_message_id?: string
      open_chat_id?: string
    }
  }
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
  CardChild,
  CardKitCard,
  LarkAdapterConfig,
  LarkAudioContent,
  LarkBehavior,
  LarkButtonElement,
  LarkCardActionBody,
  LarkCardBody,
  LarkCardElement,
  LarkCardHeader,
  LarkColumnSetElement,
  LarkFileContent,
  LarkFileType,
  LarkFormElement,
  LarkHrElement,
  LarkImageContent,
  LarkImgElement,
  LarkInputElement,
  LarkInteractiveContent,
  LarkMarkdownElement,
  LarkMediaContent,
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
