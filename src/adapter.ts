import type {
  Adapter,
  AdapterPostableMessage,
  ChannelInfo,
  ChannelVisibility,
  ChatInstance,
  EmojiValue,
  EphemeralMessage,
  FetchOptions,
  FetchResult,
  FileUpload,
  FormattedContent,
  Logger,
  ModalElement,
  ModalResponse,
  RawMessage,
  StreamChunk,
  StreamOptions,
  ThreadInfo,
  WebhookOptions,
} from 'chat'
import type {
  LarkAdapterConfig,
  LarkCardActionBody,
  LarkCardBody,
  LarkFileType,
  LarkMessageItem,
  LarkRaw,
  LarkRawMessage,
  LarkTextContent,
  LarkThreadId,
  LarkWebhookBody,
} from './types.ts'
import type { PlatformName } from '@chat-adapter/shared'
import { ValidationError, extractCard, extractFiles, toBuffer } from '@chat-adapter/shared'
import type { EventHandles } from '@larksuiteoapi/node-sdk'
import { EventDispatcher } from '@larksuiteoapi/node-sdk'
import { ConsoleLogger, Message } from 'chat'
import { LarkApiClient } from './api-client.ts'
import { LarkFormatConverter } from './format-converter.ts'
import { bridgeWebhook } from './event-bridge.ts'
import { cardMapper } from './card-mapper.ts'
import type { ModalInput } from './modal-mapper.ts'
import { MODAL_MARKER, modalMapper } from './modal-mapper.ts'

/** Extract the first parameter type of an event handler from the SDK's EventHandles. */
type EventData<TKey extends keyof EventHandles> =
  NonNullable<EventHandles[TKey]> extends (data: infer TData, ...args: unknown[]) => unknown
    ? TData
    : never

/** Recursive node shape for traversing card trees to upload images. */
type CardImageNode = { children?: CardImageNode[]; imageUrl?: string; type?: string; url?: string }

const ADAPTER_NAME = 'lark'
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

const extractText = (content: string): string => {
  try {
    const parsed = JSON.parse(content) as LarkTextContent
    if ('text' in parsed) {
      return parsed.text
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

const minimalUser = (userId: string) => ({
  fullName: '',
  isBot: false as const,
  isMe: false,
  userId,
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

const MIME_TO_LARK_FILE_TYPE: Record<string, LarkFileType> = {
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

const mimeToLarkFileType = (mime: string): LarkFileType => MIME_TO_LARK_FILE_TYPE[mime] ?? 'stream'

const mapChatTypeToVisibility = (chatType: string | undefined): ChannelVisibility => {
  if (chatType === 'public') {
    return 'workspace'
  }
  if (chatType === 'private') {
    return 'private'
  }
  return 'unknown'
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

type LarkSortType = 'ByCreateTimeAsc' | 'ByCreateTimeDesc'

const directionToSortType = (direction?: string): LarkSortType | undefined => {
  if (direction === 'forward') {
    return 'ByCreateTimeAsc'
  }
  if (direction === 'backward') {
    return 'ByCreateTimeDesc'
  }
  return undefined
}

const USER_CACHE_TTL_MS = 8 * 24 * 60 * 60 * 1000
const FAILED_LOOKUP_TTL_MS = 1 * 24 * 60 * 60 * 1000
const EPHEMERAL_ELEMENT_ID = 'eph_md'

export class LarkAdapter implements Adapter<LarkThreadId, LarkRaw> {
  readonly name = ADAPTER_NAME
  botUserId = ''

  private chat!: ChatInstance
  private readonly logger: Logger
  private botOpenId = ''
  private resolvedUserName: string
  private readonly config: LarkAdapterConfig
  private api!: LarkApiClient
  private readonly converter = new LarkFormatConverter()
  private readonly dispatcher: EventDispatcher
  private readonly dmCache = new Set<string>()
  private readonly userNameCache = new Map<string, string>()
  private pendingWebhookOptions?: WebhookOptions

  get userName(): string {
    return this.resolvedUserName
  }

  constructor(config: LarkAdapterConfig) {
    this.config = config
    this.logger = config.logger ?? new ConsoleLogger('info').child('lark')
    this.resolvedUserName = config.userName ?? 'LarkBot'
    this.dispatcher = new EventDispatcher({
      encryptKey: config.encryptKey,
      verificationToken: config.verificationToken,
    })
    this.registerEventHandlers()
  }

  async initialize(chat: ChatInstance): Promise<void> {
    this.chat = chat
    this.api = new LarkApiClient(
      {
        appId: this.config.appId,
        appSecret: this.config.appSecret,
        appType: this.config.appType,
        cache: this.config.cache,
        disableTokenCache: this.config.disableTokenCache,
        domain: this.config.domain,
        httpInstance: this.config.httpInstance,
      },
      this.logger,
    )
    const info = await this.api.getBotInfo()
    this.botOpenId = info.bot?.open_id ?? ''
    this.botUserId = this.botOpenId
    if (info.bot?.app_name && !this.config.userName) {
      this.resolvedUserName = info.bot.app_name
    }
    this.logger.info('Initialized', { botOpenId: this.botOpenId })
  }

  async disconnect(): Promise<void> {
    this.userNameCache.clear()
  }

  // -- Thread ID encoding --

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

  // -- Webhook handling --

  async handleWebhook(request: Request, options?: WebhookOptions): Promise<Response> {
    const body = await this.parseWebhookBody(request.clone() as Request)
    if (!body) {
      return new Response('Invalid JSON', { status: HTTP_BAD_REQUEST })
    }
    if (body['type'] === 'url_verification') {
      return this.handleChallenge(request)
    }
    return this.handleEvent(body, options)
  }

  // -- Message parsing --

  parseMessage(raw: LarkRawMessage): Message<LarkRaw> {
    const msg = raw.message
    if (msg.chat_type === 'p2p') {
      this.dmCache.add(msg.chat_id)
    }
    return new Message<LarkRaw>({
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

  // -- Message sending --

  async postMessage(
    threadId: string,
    message: AdapterPostableMessage,
  ): Promise<RawMessage<LarkRaw>> {
    const decoded = this.decodeThreadId(threadId)
    const files = extractFiles(message)
    const fileResults = await Promise.all(
      files.map((file) => this.uploadAndSendFile(decoded, file)),
    )
    const lastFileResult = fileResults.at(LAST_INDEX) ?? null
    const textResult = await this.sendMessageContent(decoded, message)
    const result = lastFileResult ?? textResult
    const raw: LarkMessageItem = { message_id: result.data?.message_id }
    return { id: raw.message_id ?? '', raw, threadId }
  }

  async editMessage(
    threadId: string,
    messageId: string,
    message: AdapterPostableMessage,
  ): Promise<RawMessage<LarkRaw>> {
    const card = extractCard(message)
    if (card) {
      const cardCopy = structuredClone(card)
      await this.uploadCardImages(cardCopy)
      const cardJson = cardMapper.cardToLarkInteractive(cardCopy)
      await this.api.patchCard(messageId, JSON.stringify(cardJson))
    } else {
      const { content, msgType } = renderMessage(message, this.converter)
      await this.api.updateMessage(messageId, msgType, content)
    }
    const raw: LarkMessageItem = { message_id: messageId }
    return { id: messageId, raw, threadId }
  }

  async deleteMessage(_threadId: string, messageId: string): Promise<void> {
    await this.api.deleteMessage(messageId)
  }

  // -- Reactions --

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
    const match = res.data?.items?.find((item) => item.reaction_type?.emoji_type === emojiName)
    if (match?.reaction_id) {
      await this.api.removeReaction(messageId, match.reaction_id)
    }
  }

  // -- Fetch methods --

  async fetchMessages(threadId: string, options?: FetchOptions): Promise<FetchResult<LarkRaw>> {
    const { chatId } = this.decodeThreadId(threadId)
    const sortType = directionToSortType(options?.direction)
    const res = await this.api.listMessages(chatId, options?.cursor, options?.limit, sortType)
    const items = res.data?.items ?? []
    const messages = await Promise.all(items.map((item) => this.itemToMessage(item, threadId)))
    return {
      messages,
      nextCursor: (res.data?.has_more && res.data.page_token) || undefined,
    }
  }

  async fetchThread(threadId: string): Promise<ThreadInfo> {
    const { chatId } = this.decodeThreadId(threadId)
    const res = await this.api.getChatInfo(chatId)
    return {
      channelId: chatId,
      channelName: res.data?.name,
      channelVisibility: mapChatTypeToVisibility(res.data?.chat_type),
      id: threadId,
      isDM: res.data?.chat_mode === 'p2p',
      metadata: { raw: res },
    }
  }

  async fetchMessage(threadId: string, messageId: string): Promise<Message<LarkRaw> | null> {
    const res = await this.api.getMessage(messageId)
    const item = res.data?.items?.[FIRST_ITEM_INDEX]
    if (!item) {
      return null
    }
    return await this.itemToMessage(item, threadId)
  }

  async fetchChannelInfo(channelId: string): Promise<ChannelInfo> {
    const res = await this.api.getChatInfo(channelId)
    return {
      channelVisibility: mapChatTypeToVisibility(res.data?.chat_type),
      id: channelId,
      isDM: res.data?.chat_mode === 'p2p',
      memberCount: parseMemberCount(res.data),
      metadata: { raw: res },
      name: res.data?.name,
    }
  }

  async fetchChannelMessages(
    channelId: string,
    options?: FetchOptions,
  ): Promise<FetchResult<LarkRaw>> {
    const sortType = directionToSortType(options?.direction)
    const res = await this.api.listMessages(channelId, options?.cursor, options?.limit, sortType)
    const items = res.data?.items ?? []
    const threadId = this.encodeThreadId({ chatId: channelId })
    const messages = await Promise.all(items.map((item) => this.itemToMessage(item, threadId)))
    return {
      messages,
      nextCursor: (res.data?.has_more && res.data.page_token) || undefined,
    }
  }

  async postChannelMessage(
    channelId: string,
    message: AdapterPostableMessage,
  ): Promise<RawMessage<LarkRaw>> {
    const decoded: LarkThreadId = { chatId: channelId }
    const files = extractFiles(message)
    const fileResults = await Promise.all(
      files.map((file) => this.uploadAndSendFile(decoded, file)),
    )
    const lastFileResult = fileResults.at(LAST_INDEX) ?? null
    const textResult = await this.sendMessageContent(decoded, message)
    const result = lastFileResult ?? textResult
    const raw: LarkMessageItem = { message_id: result.data?.message_id }
    const threadId = this.encodeThreadId(decoded)
    return { id: raw.message_id ?? '', raw, threadId }
  }

  getChannelVisibility(threadId: string): ChannelVisibility {
    // Lark requires an API call for chat_type; fetchChannelInfo provides full visibility.
    const { chatId } = this.decodeThreadId(threadId)
    if (this.dmCache.has(chatId)) {
      return 'private'
    }
    return 'unknown'
  }

  // -- DM --

  async openDM(userId: string): Promise<string> {
    const res = await this.api.createP2PChat(userId)
    const chatId = res.data?.chat_id ?? ''
    this.dmCache.add(chatId)
    return this.encodeThreadId({ chatId })
  }

  isDM(threadId: string): boolean {
    return this.dmCache.has(this.decodeThreadId(threadId).chatId)
  }

  // -- Misc --

  async startTyping(_threadId?: string, _status?: string): Promise<void> {
    // Lark has no typing indicator API — no-op
  }

  renderFormatted(content: FormattedContent): string {
    return this.converter.fromAst(content)
  }

  // -- Modals --

  async openModal(
    triggerId: string,
    modal: ModalElement,
    contextId?: string,
  ): Promise<{ viewId: string }> {
    const [chatId] = triggerId.split(':')
    if (!chatId) {
      throw new ValidationError(ADAPTER_NAME, 'Invalid triggerId: missing chatId')
    }
    const cardJson = modalMapper.modalToLarkCard(modal as ModalInput, contextId ?? '')
    const decoded: LarkThreadId = { chatId }
    const res = await this.sendCardMessage(decoded, cardJson)
    const messageId = res.data?.message_id ?? ''
    return { viewId: messageId }
  }

  // -- Streaming --

  async stream(
    threadId: string,
    textStream: AsyncIterable<string | StreamChunk>,
    _options?: StreamOptions,
  ): Promise<RawMessage<LarkRaw>> {
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

    const raw: LarkMessageItem = { message_id: messageId }
    return { id: messageId, raw, threadId }
  }

  // -- Ephemeral --

  async postEphemeral(
    threadId: string,
    userId: string,
    message: AdapterPostableMessage,
  ): Promise<EphemeralMessage<LarkRaw>> {
    const { chatId } = this.decodeThreadId(threadId)
    const card = extractCard(message)
    let cardObj: LarkCardBody
    if (card) {
      const cardCopy = structuredClone(card)
      await this.uploadCardImages(cardCopy)
      cardObj = cardMapper.cardToLarkInteractive(cardCopy)
    } else {
      const { content } = renderMessage(message, this.converter)
      const text = extractText(content)
      cardObj = {
        body: {
          elements: [{ content: text, element_id: EPHEMERAL_ELEMENT_ID, tag: 'markdown' }],
        },
        config: { update_multi: true },
        schema: '2.0',
      }
    }
    await this.api.sendEphemeral(chatId, userId, cardObj)
    const raw: LarkMessageItem = {}
    return { id: '', raw, threadId, usedFallback: false }
  }

  // -- Private helpers --

  private async lookupUser(openId: string): Promise<string> {
    const memCached = this.userNameCache.get(openId)
    if (memCached) return memCached

    const state = this.chat.getState()
    const cacheKey = `lark:user:${openId}`
    const cached = await state.get<{ name: string }>(cacheKey)
    if (cached) {
      this.userNameCache.set(openId, cached.name)
      return cached.name
    }

    try {
      const res = await this.api.getUser(openId)
      const name = (res as { data?: { user?: { name?: string } } }).data?.user?.name ?? openId
      this.userNameCache.set(openId, name)
      await state.set(cacheKey, { name }, USER_CACHE_TTL_MS)
      return name
    } catch {
      this.logger.warn('Failed to lookup user', { openId })
      this.userNameCache.set(openId, openId)
      await state.set(cacheKey, { name: openId }, FAILED_LOOKUP_TTL_MS)
      return openId
    }
  }

  private registerEventHandlers(): void {
    this.dispatcher.register({
      'im.chat.member.bot.added_v1': (data) => {
        this.logger.info('Bot added to chat', data)
      },
      'im.message.reaction.created_v1': (data) => {
        this.handleReactionEvent(data, true)
      },
      'im.message.reaction.deleted_v1': (data) => {
        this.handleReactionEvent(data, false)
      },
      'im.message.receive_v1': (data) => {
        this.handleMessageEvent(data)
      },
    })
  }

  private handleMessageEvent(data: EventData<'im.message.receive_v1'>): void {
    if (!data?.message) {
      return
    }
    const msg = data.message
    const options = this.pendingWebhookOptions
    const threadId = this.encodeThreadId({
      chatId: msg.chat_id,
      rootMessageId: msg.root_id || undefined,
    })

    const factory = async (): Promise<Message<LarkRaw>> => {
      // Seed user cache from mentions (free data)
      const state = this.chat.getState()
      for (const mention of msg.mentions ?? []) {
        if (mention.name && mention.id?.open_id) {
          this.userNameCache.set(mention.id.open_id, mention.name)
          void state.set(
            `lark:user:${mention.id.open_id}`,
            { name: mention.name },
            USER_CACHE_TTL_MS,
          )
        }
      }

      const openId = data.sender.sender_id?.open_id ?? ''
      const resolvedName = openId ? await this.lookupUser(openId) : ''
      const message = this.parseMessage(data)
      if (resolvedName) {
        message.author.fullName = resolvedName
        message.author.userName = resolvedName
      }
      return message
    }

    this.chat.processMessage(this, threadId, factory, options)
  }

  private handleReactionEvent(
    data: EventData<'im.message.reaction.created_v1'>,
    added: boolean,
  ): void {
    if (!data?.message_id) {
      return
    }
    const options = this.pendingWebhookOptions
    const emojiType = data.reaction_type?.emoji_type ?? ''
    const messageId = data.message_id
    const userId = data.user_id?.open_id ?? ''

    void Promise.all([
      this.resolveReactionThreadId(messageId),
      userId ? this.lookupUser(userId) : Promise.resolve(''),
    ]).then(([threadId, resolvedName]) =>
      this.chat.processReaction(
        {
          adapter: this,
          added,
          emoji: { name: emojiType, toJSON: () => '', toString: () => '' },
          messageId,
          raw: data,
          rawEmoji: emojiType,
          threadId,
          user: {
            fullName: resolvedName,
            isBot: 'unknown' as const,
            isMe: false,
            userId,
            userName: resolvedName,
          },
        },
        options,
      ),
    )
  }

  private async resolveReactionThreadId(messageId: string): Promise<string> {
    try {
      const res = await this.api.getMessage(messageId)
      const item = res.data?.items?.[FIRST_ITEM_INDEX]
      const chatId = item?.chat_id
      if (chatId) {
        return this.encodeThreadId({ chatId, rootMessageId: item?.root_id || undefined })
      }
    } catch {
      this.logger.warn('Failed to resolve threadId for reaction', { messageId })
    }
    return ''
  }

  private async parseWebhookBody(cloned: Request): Promise<LarkWebhookBody | null> {
    try {
      return (await cloned.json()) as LarkWebhookBody
    } catch {
      return null
    }
  }

  private async handleChallenge(request: Request): Promise<Response> {
    const result = await bridgeWebhook(request, this.dispatcher)
    return Response.json(result)
  }

  private handleEvent(body: LarkWebhookBody, options?: WebhookOptions): Response {
    if (body.header?.event_type === 'card.action.trigger') {
      this.handleCardAction(body as LarkCardActionBody, options)
    } else {
      this.dispatchEvent(body, options)
    }
    return new Response('ok', { status: HTTP_OK })
  }

  private handleCardAction(body: LarkCardActionBody, options?: WebhookOptions): void {
    const event = body.event
    const context = event?.context
    if (!event?.action || !context?.open_chat_id) {
      return
    }
    const action = event.action
    const chatId = context.open_chat_id
    const messageId = context.open_message_id ?? ''
    const userId = event.operator?.open_id ?? ''
    const isModal = action.value?.['__modal'] === MODAL_MARKER

    if (isModal && action.form_value) {
      this.dispatchModalSubmit(action, userId, messageId, chatId, options)
    } else if (isModal && action.form_action_type === 'reset') {
      this.dispatchModalClose(action, userId, messageId, options)
    } else {
      this.dispatchAction(action, userId, messageId, chatId, event.token, options)
    }
  }

  private dispatchModalSubmit(
    action: NonNullable<NonNullable<LarkCardActionBody['event']>['action']>,
    userId: string,
    messageId: string,
    chatId: string,
    options?: WebhookOptions,
  ): void {
    const callbackId = String(action.value?.['__callbackId'] ?? '')
    const contextId = action.value?.['__contextId'] as string | undefined
    const privateMetadata = action.value?.['__privateMetadata'] as string | undefined
    const values: Record<string, string> = {}
    if (action.form_value) {
      for (const [key, val] of Object.entries(action.form_value)) {
        // Multi-select arrays are JSON-stringified since Chat SDK values are Record<string, string>
        values[key] = Array.isArray(val) ? JSON.stringify(val) : String(val)
      }
    }

    void this.chat
      .processModalSubmit(
        {
          adapter: this,
          callbackId,
          privateMetadata,
          raw: action,
          user: minimalUser(userId),
          values,
          viewId: messageId,
        },
        contextId,
        options,
      )
      .then((response) => {
        if (response) {
          this.handleModalResponse(response, messageId, chatId, contextId ?? '')
        }
        return undefined
      })
      .catch((err: unknown) => {
        this.logger.error('Modal submit processing error', err)
      })
  }

  private dispatchModalClose(
    action: NonNullable<NonNullable<LarkCardActionBody['event']>['action']>,
    userId: string,
    messageId: string,
    options?: WebhookOptions,
  ): void {
    if (action.value?.['__notifyOnClose'] !== '1') {
      return
    }
    const callbackId = String(action.value?.['__callbackId'] ?? '')
    const contextId = action.value?.['__contextId'] as string | undefined
    const privateMetadata = action.value?.['__privateMetadata'] as string | undefined

    this.chat.processModalClose(
      {
        adapter: this,
        callbackId,
        privateMetadata,
        raw: action,
        user: minimalUser(userId),
        viewId: messageId,
      },
      contextId,
      options,
    )
  }

  private dispatchAction(
    action: NonNullable<NonNullable<LarkCardActionBody['event']>['action']>,
    userId: string,
    messageId: string,
    chatId: string,
    token?: string,
    options?: WebhookOptions,
  ): void {
    const actionValue = action.value ?? {}
    const actionId = String(actionValue['id'] ?? '')
    const value = action.option ?? String(actionValue['action'] ?? '')
    const threadId = this.encodeThreadId({ chatId })
    const triggerId = `${chatId}:${messageId}`

    this.chat.processAction(
      {
        actionId,
        adapter: this,
        messageId,
        raw: action,
        threadId,
        triggerId,
        user: minimalUser(userId),
        value: value || undefined,
      },
      options,
    )
  }

  private handleModalResponse(
    response: ModalResponse,
    messageId: string,
    chatId: string,
    contextId: string,
  ): void {
    if (!response || response.action === 'close') {
      return
    }

    if (response.action === 'errors') {
      // Send errors as a reply message instead of patching the card,
      // so the form stays intact and the user can correct their input.
      const errorText = Object.entries(response.errors)
        .map(([field, msg]) => `**${field}**: ${msg}`)
        .join('\n')
      const content = JSON.stringify({ text: `\u26a0\ufe0f Validation errors:\n${errorText}` })
      void this.api.replyMessage(messageId, 'text', content).catch((err: unknown) => {
        this.logger.error('Failed to send validation errors', err)
      })
      return
    }

    if (response.action === 'update' || response.action === 'push') {
      const cardJson = modalMapper.modalToLarkCard(response.modal as ModalInput, contextId)
      if (response.action === 'update') {
        void this.api.patchCard(messageId, JSON.stringify(cardJson)).catch((err: unknown) => {
          this.logger.error('Failed to update modal card', err)
        })
      } else {
        void this.sendCardMessage({ chatId }, cardJson).catch((err: unknown) => {
          this.logger.error('Failed to push modal card', err)
        })
      }
    }
  }

  private dispatchEvent(body: LarkWebhookBody, options?: WebhookOptions): void {
    this.pendingWebhookOptions = options
    void (this.dispatcher.invoke(body as Record<string, unknown>) as Promise<unknown>)
      .catch((err: unknown) => {
        this.logger.error('Event processing error', err)
      })
      .finally(() => {
        this.pendingWebhookOptions = undefined
      })
  }

  private extractImageKey(uploadRes: { image_key?: string } | null): string {
    return uploadRes?.image_key ?? ''
  }

  private async sendUploadedImage(decoded: LarkThreadId, buf: Buffer) {
    const uploadRes = await this.api.uploadImage(buf)
    const imageKey = this.extractImageKey(uploadRes)
    return this.sendOrReply(decoded, 'image', JSON.stringify({ image_key: imageKey }))
  }

  private async sendUploadedFile(decoded: LarkThreadId, buf: Buffer, file: FileUpload) {
    const mime = file.mimeType ?? ''
    const uploadRes = await this.api.uploadFile(buf, file.filename, mimeToLarkFileType(mime))
    const fileKey = uploadRes?.file_key ?? ''
    return this.sendOrReply(decoded, 'file', JSON.stringify({ file_key: fileKey }))
  }

  private async uploadAndSendFile(decoded: LarkThreadId, file: FileUpload) {
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

  private async sendMessageContent(decoded: LarkThreadId, message: AdapterPostableMessage) {
    const card = extractCard(message)
    if (card) {
      const cardCopy = structuredClone(card)
      await this.uploadCardImages(cardCopy)
      const cardJson = cardMapper.cardToLarkInteractive(cardCopy)
      return this.sendCardMessage(decoded, cardJson)
    }
    return this.sendTextMessage(decoded, message)
  }

  private async fetchAndUploadImage(url: string): Promise<string | null> {
    const response = await fetch(url)
    const buf = Buffer.from(await response.arrayBuffer())
    const uploadRes = await this.api.uploadImage(buf)
    return this.extractImageKey(uploadRes) || null
  }

  private async uploadUrlToImageKey(node: CardImageNode, field: 'imageUrl' | 'url'): Promise<void> {
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
      this.logger.warn('Failed to upload card image', { field, url })
    }
  }

  private async uploadCardImages(node: CardImageNode, isRoot = true): Promise<void> {
    if (node.type === 'image') {
      await this.uploadUrlToImageKey(node, 'url')
    }
    if (isRoot) {
      await this.uploadUrlToImageKey(node, 'imageUrl')
    }
    if (node.children) {
      await Promise.all(node.children.map((child) => this.uploadCardImages(child, false)))
    }
  }

  private async sendCardMessage(decoded: LarkThreadId, cardJson: LarkCardBody) {
    const res = await this.api.createCard(JSON.stringify(cardJson))
    const cardId = res.data?.card_id ?? ''
    const content = JSON.stringify({ data: { card_id: cardId }, type: 'card' })
    return this.sendOrReply(decoded, 'interactive', content)
  }

  private async sendTextMessage(decoded: LarkThreadId, message: AdapterPostableMessage) {
    const { content, msgType } = renderMessage(message, this.converter)
    return this.sendOrReply(decoded, msgType, content)
  }

  private async createStreamingCard(
    decoded: LarkThreadId,
  ): Promise<{ cardId: string; messageId: string }> {
    const cardJson: LarkCardBody = {
      body: {
        elements: [{ content: '', element_id: STREAM_ELEMENT_ID, tag: 'markdown' }],
      },
      config: { streaming_mode: true, update_multi: true },
      schema: '2.0',
    }
    const res = await this.api.createCard(JSON.stringify(cardJson))
    const cardId = res.data?.card_id ?? ''
    const content = JSON.stringify({ data: { card_id: cardId }, type: 'card' })
    const sendRes = await this.sendOrReply(decoded, 'interactive', content)
    return { cardId, messageId: sendRes.data?.message_id ?? '' }
  }

  private async sendOrReply(decoded: LarkThreadId, msgType: string, content: string) {
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

  private async itemToMessage(item: LarkMessageItem, threadId: string): Promise<Message<LarkRaw>> {
    const content = item.body?.content ?? ''
    const sender = item.sender
    const senderId = sender?.id ?? ''
    const resolvedName = senderId ? await this.lookupUser(senderId) : 'unknown'
    const author = sender
      ? {
          fullName: resolvedName,
          isBot: sender.sender_type === 'app',
          isMe: sender.id === this.botOpenId,
          userId: sender.id,
          userName: resolvedName,
        }
      : unknownAuthor()
    return new Message<LarkRaw>({
      attachments: [],
      author,
      formatted: this.converter.toAst(content),
      id: item.message_id ?? '',
      metadata: {
        dateSent: new Date(Number(item.create_time ?? '0')),
        edited: item.updated === true,
      },
      raw: item,
      text: extractText(content),
      threadId,
    })
  }
}
