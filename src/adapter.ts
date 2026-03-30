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
import type { LarkAdapterConfig, LarkMessageItem, LarkRawMessage, LarkThreadId } from './types.ts'
import type { PlatformName } from '@chat-adapter/shared'
import { ValidationError, extractCard, extractFiles, toBuffer } from '@chat-adapter/shared'
import { EventDispatcher } from '@larksuiteoapi/node-sdk'
import { Message } from 'chat'
import DedupCache from './dedup-cache.ts'
import LarkApiClient from './api-client.ts'
import LarkFormatConverter from './format-converter.ts'
import bridgeWebhook from './event-bridge.ts'
import cardMapper from './card-mapper.ts'

const ADAPTER_NAME = 'lark'
const DEDUP_CAPACITY = 500
const STREAM_ELEMENT_ID = 'stream_md'
const INITIAL_SEQUENCE = 1
const MIN_DECODE_PARTS = 2
const PREFIX_INDEX = 0
const CHAT_ID_INDEX = 1
const ROOT_MSG_INDEX = 2
const FIRST_ITEM_INDEX = 0
const HTTP_BAD_REQUEST = 400
const HTTP_OK = 200
const LAST_INDEX = -1

/** Response shape from Lark message send/reply APIs. */
interface LarkMessageResult {
  code?: number
  data?: { message_id?: string }
  msg?: string
}

/** Response shape from Lark CardKit create API. */
interface LarkCardResult {
  code?: number
  data?: { card_id: string }
  msg?: string
}

const toBase64Url = (str: string): string => Buffer.from(str).toString('base64url')

const fromBase64Url = (str: string): string => Buffer.from(str, 'base64url').toString()

const isHttpUrl = (value: string): boolean =>
  value.startsWith('http://') || value.startsWith('https://')

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
  return renderObjectMessage(message, converter)
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

const MIME_TO_LARK_FILE_TYPE: Record<string, string> = {
  'application/msword': 'doc',
  'application/pdf': 'pdf',
  'application/vnd.ms-excel': 'xls',
  'application/vnd.ms-powerpoint': 'ppt',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': 'ppt',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xls',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'doc',
  'audio/ogg': 'opus',
  'audio/opus': 'opus',
  'video/mp4': 'mp4',
}

const mimeToLarkFileType = (mime: string): string => {
  if (MIME_TO_LARK_FILE_TYPE[mime]) {
    return MIME_TO_LARK_FILE_TYPE[mime]
  }
  return 'stream'
}

const parseMemberCount = (
  data: { bot_count?: string; user_count?: string } | undefined,
): number | undefined => {
  const count = Number(data?.user_count)
  if (Number.isFinite(count)) {
    return count
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
      encryptKey: config.encryptKey,
      verificationToken: config.verificationToken,
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
    const body = await this.parseWebhookBody(request.clone() as Request)
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
    const textResult = await this.sendMessageContent(decoded, message)
    const result = lastFileResult ?? textResult
    return { id: result.data?.message_id ?? '', raw: result as unknown as LarkRawMessage, threadId }
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
      data?: { has_more?: boolean; items?: LarkMessageItem[]; page_token?: string }
    }
    const messages = (data.data?.items ?? []).map((item) => this.itemToMessage(item, threadId))
    return {
      messages,
      nextCursor: (data.data?.has_more && data.data.page_token) || undefined,
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
    const data = res as { data?: { items?: LarkMessageItem[] } }
    const item = data.data?.items?.[FIRST_ITEM_INDEX]
    if (!item) {
      return null
    }
    return this.itemToMessage(item, threadId)
  }

  async fetchChannelInfo(channelId: string): Promise<ChannelInfo> {
    const res = await this.api.getChatInfo(channelId)
    const data = res as {
      data?: { bot_count?: string; chat_mode?: string; name?: string; user_count?: string }
    }
    return {
      id: channelId,
      isDM: data.data?.chat_mode === 'p2p',
      memberCount: parseMemberCount(data.data),
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

  async startTyping(_threadId?: string, _status?: string): Promise<void> {
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
    const { cardId, messageId } = await this.createStreamingCard(this.decodeThreadId(threadId))
    let sequence = INITIAL_SEQUENCE
    let accumulated = ''

    try {
      for await (const chunk of textStream) {
        accumulated += chunkToText(chunk)
        await this.api.streamUpdateText({
          cardId,
          content: accumulated,
          elementId: STREAM_ELEMENT_ID,
          sequence: sequence++,
        })
      }
    } finally {
      await this.api.updateCardSettings(
        cardId,
        JSON.stringify({ config: { streaming_mode: false } }),
        sequence,
      )
    }

    return { id: messageId, raw: {} as LarkRawMessage, threadId }
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
      user: {
        fullName: '',
        isBot: 'unknown' as const,
        isMe: false,
        userId: ev.user_id?.open_id ?? '',
        userName: '',
      },
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

  private async sendUploadedImage(decoded: LarkThreadId, buf: Buffer): Promise<LarkMessageResult> {
    const uploadRes = await this.api.uploadImage(buf)
    const uploadData = uploadRes as { data?: { image_key?: string } }
    const imageKey = uploadData.data?.image_key ?? ''
    return this.sendOrReply(decoded, 'image', JSON.stringify({ image_key: imageKey }))
  }

  private async sendUploadedFile(
    decoded: LarkThreadId,
    buf: Buffer,
    file: FileUpload,
  ): Promise<LarkMessageResult> {
    const mime = file.mimeType ?? ''
    const uploadRes = await this.api.uploadFile(buf, file.filename, mimeToLarkFileType(mime))
    const uploadData = uploadRes as { data?: { file_key?: string } }
    const fileKey = uploadData.data?.file_key ?? ''
    return this.sendOrReply(decoded, 'file', JSON.stringify({ file_key: fileKey }))
  }

  private async uploadAndSendFile(
    decoded: LarkThreadId,
    file: FileUpload,
  ): Promise<LarkMessageResult | null> {
    const buf = await toBuffer(file.data, { platform: ADAPTER_NAME as PlatformName })
    if (!buf) {
      return null
    }
    const mime = file.mimeType ?? ''
    if (mime.startsWith('image/')) {
      return this.sendUploadedImage(decoded, buf)
    }
    return this.sendUploadedFile(decoded, buf, file)
  }

  private async sendMessageContent(
    decoded: LarkThreadId,
    message: AdapterPostableMessage,
  ): Promise<LarkMessageResult> {
    const card = extractCard(message)
    if (card) {
      await this.uploadCardImages(card as Record<string, unknown>)
      const cardJson = cardMapper.cardToLarkInteractive(card)
      return this.sendCardMessage(decoded, cardJson)
    }
    return this.sendTextMessage(decoded, message)
  }

  private async fetchAndUploadImage(url: string): Promise<string | null> {
    const response = await fetch(url)
    const buf = Buffer.from(await response.arrayBuffer())
    const uploadRes = await this.api.uploadImage(buf)
    const data = uploadRes as { data?: { image_key?: string } }
    return data.data?.image_key ?? null
  }

  private async uploadUrlToImageKey(node: Record<string, unknown>, field: string): Promise<void> {
    const url = node[field]
    if (typeof url !== 'string' || !isHttpUrl(url)) {
      return
    }
    try {
      const key = await this.fetchAndUploadImage(url)
      if (key) {
        node[field] = key
      }
    } catch {
      this.logger?.warn?.('Failed to upload card image', { field, url })
    }
  }

  private async uploadCardImages(node: Record<string, unknown>): Promise<void> {
    if (node['type'] === 'image') {
      await this.uploadUrlToImageKey(node, 'url')
    }
    await this.uploadUrlToImageKey(node, 'imageUrl')
    const children = node['children'] as Array<Record<string, unknown>> | undefined
    if (children) {
      await Promise.all(children.map((child) => this.uploadCardImages(child)))
    }
  }

  private async sendCardMessage(
    decoded: LarkThreadId,
    cardJson: Record<string, unknown>,
  ): Promise<LarkMessageResult> {
    const res = (await this.api.createCard(JSON.stringify(cardJson))) as LarkCardResult
    const cardId = res.data?.card_id ?? ''
    const content = JSON.stringify({ data: { card_id: cardId }, type: 'card' })
    return this.sendOrReply(decoded, 'interactive', content)
  }

  private async sendTextMessage(
    decoded: LarkThreadId,
    message: AdapterPostableMessage,
  ): Promise<LarkMessageResult> {
    const { content, msgType } = renderMessage(message, this.converter)
    return this.sendOrReply(decoded, msgType, content)
  }

  private async createStreamingCard(
    decoded: LarkThreadId,
  ): Promise<{ cardId: string; messageId: string }> {
    const cardJson: Record<string, unknown> = {
      body: {
        elements: [{ content: '', element_id: STREAM_ELEMENT_ID, tag: 'markdown' }],
      },
      config: { streaming_mode: true, update_multi: true },
      schema: '2.0',
    }
    const res = (await this.api.createCard(JSON.stringify(cardJson))) as LarkCardResult
    const cardId = res.data?.card_id ?? ''
    const content = JSON.stringify({ data: { card_id: cardId }, type: 'card' })
    const sendRes = await this.sendOrReply(decoded, 'interactive', content)
    return { cardId, messageId: sendRes.data?.message_id ?? '' }
  }

  private async sendOrReply(
    decoded: LarkThreadId,
    msgType: string,
    content: string,
  ): Promise<LarkMessageResult> {
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

  private itemToMessage(item: LarkMessageItem, threadId: string): Message<LarkRawMessage> {
    const content = item.body?.content ?? ''
    return new Message<LarkRawMessage>({
      attachments: [],
      author: unknownAuthor(),
      formatted: this.converter.toAst(content),
      id: item.message_id ?? '',
      metadata: {
        dateSent: new Date(Number(item.create_time ?? '0')),
        edited: false,
      },
      raw: item as unknown as LarkRawMessage,
      text: extractText(content),
      threadId,
    })
  }
}
