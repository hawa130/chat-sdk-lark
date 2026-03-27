/* eslint-disable no-duplicate-imports, sort-imports */
import type {
  Adapter,
  AdapterPostableMessage,
  ChannelInfo,
  ChatInstance,
  EmojiValue,
  EphemeralMessage,
  FetchOptions,
  FetchResult,
  FileUpload,
  FormattedContent,
  Logger,
  RawMessage,
  StreamChunk,
  ThreadInfo,
  WebhookOptions,
} from 'chat'
import type { LarkAdapterConfig, LarkRawMessage, LarkThreadId } from './types.ts'
import { ValidationError, extractCard, extractFiles, toBuffer } from '@chat-adapter/shared'
import { EventDispatcher } from '@larksuiteoapi/node-sdk'
import { Message } from 'chat'
import DedupCache from './dedup-cache.ts'
import LarkApiClient from './api-client.ts'
import LarkFormatConverter from './format-converter.ts'
import bridgeWebhook from './event-bridge.ts'
import cardMapper from './card-mapper.ts'
/* eslint-enable no-duplicate-imports, sort-imports */

const ADAPTER_NAME = 'lark'
const DEDUP_CAPACITY = 500
const STREAM_THROTTLE_MS = 400
const STREAM_PLACEHOLDER = '...'
const MIN_DECODE_PARTS = 2
const PREFIX_INDEX = 0
const CHAT_ID_INDEX = 1
const ROOT_MSG_INDEX = 2
const FIRST_ITEM_INDEX = 0
const HTTP_BAD_REQUEST = 400
const HTTP_OK = 200
const LAST_INDEX = -1

const toBase64Url = (str: string): string => Buffer.from(str).toString('base64url')

const fromBase64Url = (str: string): string => Buffer.from(str, 'base64url').toString()

const renderCardMessage = (
  message: AdapterPostableMessage,
): { content: string; msgType: string } | null => {
  const card = extractCard(message)
  if (!card) {
    return null
  }
  const interactive = cardMapper.cardToLarkInteractive(card)
  return { content: JSON.stringify(interactive), msgType: 'interactive' }
}

const renderObjectMessage = (
  message: AdapterPostableMessage,
  converter: LarkFormatConverter,
): { content: string; msgType: string } => {
  if (typeof message === 'object' && 'markdown' in message) {
    return converter.renderForSend({ text: message.markdown })
  }
  if (typeof message === 'object' && 'raw' in message) {
    return converter.renderForSend({ text: message.raw })
  }
  if (typeof message === 'object' && 'ast' in message) {
    return converter.renderForSend({ text: converter.fromAst(message.ast) })
  }
  return converter.renderForSend({ text: '' })
}

const renderMessage = (
  message: AdapterPostableMessage,
  converter: LarkFormatConverter,
): { content: string; msgType: string } => {
  if (typeof message === 'string') {
    return converter.renderForSend({ text: message })
  }
  return renderCardMessage(message) ?? renderObjectMessage(message, converter)
}

const extractEmojiName = (emoji: EmojiValue | string): string => {
  if (typeof emoji === 'string') {
    return emoji
  }
  return emoji.name
}

const extractEventId = (body: Record<string, unknown>): string | undefined => {
  const header = body['header'] as Record<string, unknown> | undefined
  return header?.['event_id'] as string | undefined
}

const extractText = (content: string): string => {
  try {
    const parsed = JSON.parse(content) as Record<string, unknown>
    if ('text' in parsed) {
      return String(parsed['text'])
    }
    return content
  } catch {
    return content
  }
}

const buildAuthor = (raw: LarkRawMessage, botOpenId: string) => {
  const { sender } = raw
  const openId = sender.sender_id?.open_id ?? ''
  const isBot = sender.sender_type === 'bot'
  const isMe = openId === botOpenId
  const mentionName = raw.message.mentions?.find((mention) => mention.id.open_id === openId)?.name
  return {
    fullName: mentionName ?? openId,
    isBot,
    isMe,
    userId: openId,
    userName: openId,
  }
}

const buildIsMention = (raw: LarkRawMessage, botOpenId: string): boolean => {
  if (raw.message.chat_type === 'p2p') {
    return true
  }
  return raw.message.mentions?.some((mention) => mention.id.open_id === botOpenId) ?? false
}

const unknownAuthor = () => ({
  fullName: 'unknown',
  isBot: 'unknown' as const,
  isMe: false,
  userId: '',
  userName: '',
})

const chunkToText = (chunk: string | StreamChunk): string => {
  if (typeof chunk === 'string') {
    return chunk
  }
  if ('text' in chunk) {
    return chunk.text
  }
  return ''
}

const getMemberCount = (data: { member_list?: unknown[] } | undefined): number | undefined => {
  if (Array.isArray(data?.member_list)) {
    return data.member_list.length
  }
  return undefined
}

export default class LarkAdapter implements Adapter<LarkThreadId, LarkRawMessage> {
  readonly name = ADAPTER_NAME
  readonly userName: string

  private chat!: ChatInstance
  private logger!: Logger
  private botOpenId = ''
  private readonly config: LarkAdapterConfig
  private readonly api: LarkApiClient
  private readonly converter = new LarkFormatConverter()
  private readonly dedup = new DedupCache(DEDUP_CAPACITY)
  private readonly dispatcher: EventDispatcher
  private readonly dmCache = new Set<string>()

  constructor(config: LarkAdapterConfig) {
    this.config = config
    this.userName = config.userName ?? 'LarkBot'
    this.api = new LarkApiClient({
      appId: config.appId,
      appSecret: config.appSecret,
      disableTokenCache: config.disableTokenCache,
      domain: config.domain,
    })
    this.dispatcher = new EventDispatcher({
      encryptKey: config.encryptKey ?? '',
    })
    this.registerEventHandlers()
  }

  async initialize(chat: ChatInstance): Promise<void> {
    this.chat = chat
    this.logger = chat.getLogger(ADAPTER_NAME)
    const info = await this.api.getBotInfo()
    this.botOpenId = info.bot?.open_id ?? ''
    if (info.bot?.app_name && !this.config.userName) {
      ;(this as { userName: string }).userName = info.bot.app_name
    }
    this.logger.info('Initialized', { botOpenId: this.botOpenId })
  }

  async disconnect(): Promise<void> {
    this.dedup.clear()
  }

  // -- Thread ID encoding (7A) --

  encodeThreadId(data: LarkThreadId): string {
    const base = `lark:${toBase64Url(data.chatId)}`
    if (data.rootMessageId) {
      return `${base}:${toBase64Url(data.rootMessageId)}`
    }
    return base
  }

  decodeThreadId(threadId: string): LarkThreadId {
    const parts = threadId.split(':')
    if (parts[PREFIX_INDEX] !== 'lark') {
      throw new ValidationError(ADAPTER_NAME, `Invalid thread ID prefix: ${parts[PREFIX_INDEX]}`)
    }
    if (parts.length < MIN_DECODE_PARTS || !parts[CHAT_ID_INDEX]) {
      throw new ValidationError(ADAPTER_NAME, 'Thread ID missing chatId segment')
    }
    const chatId = fromBase64Url(parts[CHAT_ID_INDEX])
    if (parts[ROOT_MSG_INDEX]) {
      return { chatId, rootMessageId: fromBase64Url(parts[ROOT_MSG_INDEX]) }
    }
    return { chatId }
  }

  channelIdFromThreadId(threadId: string): string {
    return this.decodeThreadId(threadId).chatId
  }

  // -- Webhook handling (7B) --

  async handleWebhook(request: Request, options?: WebhookOptions): Promise<Response> {
    const body = await this.parseWebhookBody(request.clone())
    if (!body) {
      return new Response('Invalid JSON', { status: HTTP_BAD_REQUEST })
    }
    if (body['type'] === 'url_verification') {
      return this.handleChallenge(request)
    }
    return this.handleEvent(body, request, options)
  }

  // -- Message parsing (7C) --

  parseMessage(raw: LarkRawMessage): Message<LarkRawMessage> {
    const msg = raw.message
    if (msg.chat_type === 'p2p') {
      this.dmCache.add(msg.chat_id)
    }
    return new Message<LarkRawMessage>({
      attachments: [],
      author: buildAuthor(raw, this.botOpenId),
      formatted: this.converter.toAst(msg.content),
      id: msg.message_id,
      isMention: buildIsMention(raw, this.botOpenId),
      metadata: {
        dateSent: new Date(Number(msg.create_time)),
        edited: msg.update_time != null && msg.update_time !== msg.create_time,
      },
      raw,
      text: this.resolveText(msg),
      threadId: this.encodeThreadId({
        chatId: msg.chat_id,
        rootMessageId: msg.root_id || undefined,
      }),
    })
  }

  // -- Message sending (7D) --

  async postMessage(
    threadId: string,
    message: AdapterPostableMessage,
  ): Promise<RawMessage<LarkRawMessage>> {
    const decoded = this.decodeThreadId(threadId)
    const files = extractFiles(message)
    const fileResults = await Promise.all(
      files.map((file) => this.uploadAndSendFile(decoded, file)),
    )
    const lastFileResult = fileResults.at(LAST_INDEX) ?? null
    const { content, msgType } = renderMessage(message, this.converter)
    const textResult = await this.sendOrReply(decoded, msgType, content)
    const finalResult = lastFileResult ?? textResult
    const data = finalResult as { data?: { message_id?: string } }
    return { id: data.data?.message_id ?? '', raw: finalResult as LarkRawMessage, threadId }
  }

  async editMessage(
    threadId: string,
    messageId: string,
    message: AdapterPostableMessage,
  ): Promise<RawMessage<LarkRawMessage>> {
    const { content, msgType } = renderMessage(message, this.converter)
    const result = await this.api.updateMessage(messageId, msgType, content)
    return { id: messageId, raw: result as LarkRawMessage, threadId }
  }

  async deleteMessage(_threadId: string, messageId: string): Promise<void> {
    await this.api.deleteMessage(messageId)
  }

  // -- Reactions (7E) --

  async addReaction(
    _threadId: string,
    messageId: string,
    emoji: EmojiValue | string,
  ): Promise<void> {
    await this.api.addReaction(messageId, extractEmojiName(emoji))
  }

  async removeReaction(
    _threadId: string,
    messageId: string,
    emoji: EmojiValue | string,
  ): Promise<void> {
    const emojiName = extractEmojiName(emoji)
    const res = await this.api.listReactions(messageId)
    const data = res as {
      data?: { items?: Array<{ reaction_id?: string; reaction_type?: { emoji_type?: string } }> }
    }
    const match = data.data?.items?.find((item) => item.reaction_type?.emoji_type === emojiName)
    if (match?.reaction_id) {
      await this.api.removeReaction(messageId, match.reaction_id)
    }
  }

  // -- Fetch methods (7F) --

  async fetchMessages(
    threadId: string,
    options?: FetchOptions,
  ): Promise<FetchResult<LarkRawMessage>> {
    const { chatId } = this.decodeThreadId(threadId)
    const res = await this.api.listMessages(chatId, options?.cursor, options?.limit)
    const data = res as {
      data?: { has_more?: boolean; items?: Array<Record<string, unknown>>; page_token?: string }
    }
    const messages = (data.data?.items ?? []).map((item) => this.itemToMessage(item, threadId))
    return {
      messages,
      nextCursor: data.data?.has_more ? data.data.page_token : undefined, // eslint-disable-line no-ternary
    }
  }

  async fetchThread(threadId: string): Promise<ThreadInfo> {
    const { chatId } = this.decodeThreadId(threadId)
    const res = await this.api.getChatInfo(chatId)
    const data = res as { data?: { chat_mode?: string; name?: string } }
    return {
      channelId: chatId,
      channelName: data.data?.name,
      id: threadId,
      isDM: data.data?.chat_mode === 'p2p',
      metadata: { raw: data },
    }
  }

  async fetchMessage(threadId: string, messageId: string): Promise<Message<LarkRawMessage> | null> {
    const res = await this.api.getMessage(messageId)
    const data = res as { data?: { items?: Array<Record<string, unknown>> } }
    const item = data.data?.items?.[FIRST_ITEM_INDEX]
    if (!item) {
      return null
    }
    return this.itemToMessage(item, threadId)
  }

  async fetchChannelInfo(channelId: string): Promise<ChannelInfo> {
    const res = await this.api.getChatInfo(channelId)
    const data = res as {
      data?: { chat_mode?: string; member_list?: unknown[]; name?: string }
    }
    return {
      id: channelId,
      isDM: data.data?.chat_mode === 'p2p',
      memberCount: getMemberCount(data.data),
      metadata: { raw: data },
      name: data.data?.name,
    }
  }

  // -- DM (7F) --

  async openDM(userId: string): Promise<string> {
    const res = await this.api.createP2PChat(userId)
    const data = res as { data?: { chat_id?: string } }
    const chatId = data.data?.chat_id ?? ''
    this.dmCache.add(chatId)
    return this.encodeThreadId({ chatId })
  }

  isDM(threadId: string): boolean {
    return this.dmCache.has(this.decodeThreadId(threadId).chatId)
  }

  // -- Misc (7F) --

  async startTyping(): Promise<void> {
    // Lark has no typing indicator API — no-op
  }

  renderFormatted(content: FormattedContent): string {
    return this.converter.fromAst(content)
  }

  // -- Streaming (7G) --

  async stream(
    threadId: string,
    textStream: AsyncIterable<string | StreamChunk>,
  ): Promise<RawMessage<LarkRawMessage>> {
    const posted = await this.postMessage(threadId, STREAM_PLACEHOLDER)
    const state = { accumulated: '', lastEditTime: 0 }

    try {
      for await (const chunk of textStream) {
        state.accumulated += chunkToText(chunk)
        await this.throttledEdit(threadId, posted.id, state)
      }
    } finally {
      if (state.accumulated) {
        await this.editMessage(threadId, posted.id, state.accumulated)
      }
    }

    return posted
  }

  // -- Ephemeral (7H) --

  async postEphemeral(
    threadId: string,
    userId: string,
    message: AdapterPostableMessage,
  ): Promise<EphemeralMessage<LarkRawMessage>> {
    const { chatId } = this.decodeThreadId(threadId)
    const { content } = renderMessage(message, this.converter)
    const result = await this.api.sendEphemeral(chatId, userId, content)
    return { id: '', raw: result as LarkRawMessage, threadId, usedFallback: false }
  }

  // -- Private helpers --

  private registerEventHandlers(): void {
    this.dispatcher.register({
      'im.chat.member.bot.added_v1': (data: unknown) => {
        this.logger?.info?.('Bot added to chat', data)
      },
      'im.message.reaction.created_v1': (data: unknown) => {
        this.handleReactionEvent(data, true)
      },
      'im.message.reaction.deleted_v1': (data: unknown) => {
        this.handleReactionEvent(data, false)
      },
      'im.message.receive_v1': (data: unknown) => {
        this.handleMessageEvent(data)
      },
    })
  }

  private handleMessageEvent(data: unknown): void {
    // SDK v2 flattens header + event into top level (no nested .event)
    const raw = data as LarkRawMessage
    if (!raw?.message) {
      return
    }
    const message = this.parseMessage(raw)
    this.chat.processMessage(this, message.threadId, message, {})
  }

  private handleReactionEvent(data: unknown, added: boolean): void {
    // SDK v2 flattens header + event into top level
    const ev = data as {
      message_id?: string
      reaction_type?: { emoji_type?: string }
      user_id?: { open_id?: string }
    }
    if (!ev?.message_id) {
      return
    }
    const emojiType = ev.reaction_type?.emoji_type ?? ''
    this.chat.processReaction({
      adapter: this,
      added,
      emoji: { name: emojiType, toJSON: () => '', toString: () => '' },
      messageId: ev.message_id,
      raw: data,
      rawEmoji: emojiType,
      threadId: '',
      userId: ev.user_id?.open_id ?? '',
    })
  }

  private async parseWebhookBody(cloned: Request): Promise<Record<string, unknown> | null> {
    try {
      return (await cloned.json()) as Record<string, unknown>
    } catch {
      return null
    }
  }

  private async handleChallenge(request: Request): Promise<Response> {
    const result = await bridgeWebhook(request, this.dispatcher)
    return Response.json(result)
  }

  private handleEvent(
    body: Record<string, unknown>,
    request: Request,
    options?: WebhookOptions,
  ): Response {
    const eventId = extractEventId(body)
    if (eventId && this.dedup.has(eventId)) {
      return new Response('ok', { status: HTTP_OK })
    }
    if (eventId) {
      this.dedup.add(eventId)
    }
    this.dispatchEvent(body, request, options)
    return new Response('ok', { status: HTTP_OK })
  }

  private dispatchEvent(
    body: Record<string, unknown>,
    request: Request,
    options?: WebhookOptions,
  ): void {
    const bridgeRequest = new Request(request.url, {
      body: JSON.stringify(body),
      headers: request.headers,
      method: request.method,
    })
    const promise = bridgeWebhook(bridgeRequest, this.dispatcher)
    if (options?.waitUntil) {
      options.waitUntil(promise)
      return
    }
    // eslint-disable-next-line promise/prefer-await-to-then, promise/prefer-await-to-callbacks
    void promise.then(undefined, (err: unknown) => {
      this.logger?.error?.('Event processing error', err)
    })
  }

  private async sendUploadedImage(decoded: LarkThreadId, buf: Buffer): Promise<unknown> {
    const uploadRes = await this.api.uploadImage(buf)
    const uploadData = uploadRes as { data?: { image_key?: string } }
    const imageKey = uploadData.data?.image_key ?? ''
    return this.sendOrReply(decoded, 'image', JSON.stringify({ image_key: imageKey }))
  }

  private async sendUploadedFile(
    decoded: LarkThreadId,
    buf: Buffer,
    file: FileUpload,
  ): Promise<unknown> {
    const mime = file.mimeType ?? ''
    const uploadRes = await this.api.uploadFile(buf, file.filename, mime)
    const uploadData = uploadRes as { data?: { file_key?: string } }
    const fileKey = uploadData.data?.file_key ?? ''
    return this.sendOrReply(decoded, 'file', JSON.stringify({ file_key: fileKey }))
  }

  private async uploadAndSendFile(decoded: LarkThreadId, file: FileUpload): Promise<unknown> {
    const buf = await toBuffer(file.data, { platform: ADAPTER_NAME })
    if (!buf) {
      return null
    }
    const mime = file.mimeType ?? ''
    if (mime.startsWith('image/')) {
      return this.sendUploadedImage(decoded, buf)
    }
    return this.sendUploadedFile(decoded, buf, file)
  }

  private async sendOrReply(
    decoded: LarkThreadId,
    msgType: string,
    content: string,
  ): Promise<unknown> {
    if (decoded.rootMessageId) {
      return this.api.replyMessage(decoded.rootMessageId, msgType, content)
    }
    return this.api.sendMessage(decoded.chatId, msgType, content)
  }

  private resolveText(msg: LarkRawMessage['message']): string {
    const raw = extractText(msg.content)
    if (!msg.mentions) {
      return raw
    }
    return this.converter.replaceMentions(
      raw,
      msg.mentions.map((mention) => ({ key: mention.key, name: mention.name })),
    )
  }

  private async throttledEdit(
    threadId: string,
    messageId: string,
    state: { accumulated: string; lastEditTime: number },
  ): Promise<void> {
    const now = Date.now()
    if (now - state.lastEditTime >= STREAM_THROTTLE_MS) {
      await this.editMessage(threadId, messageId, state.accumulated)
      state.lastEditTime = Date.now()
    }
  }

  private itemToMessage(item: Record<string, unknown>, threadId: string): Message<LarkRawMessage> {
    return new Message<LarkRawMessage>({
      attachments: [],
      author: unknownAuthor(),
      formatted: this.converter.toAst(String(item['content'] ?? '')),
      id: String(item['message_id'] ?? ''),
      metadata: {
        dateSent: new Date(Number(item['create_time'] ?? '0')),
        edited: false,
      },
      raw: item as unknown as LarkRawMessage,
      text: extractText(String(item['content'] ?? '')),
      threadId,
    })
  }
}
