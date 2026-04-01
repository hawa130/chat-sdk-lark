import { AppType, Client, Domain, LoggerLevel } from '@larksuiteoapi/node-sdk'
import {
  AdapterError,
  AdapterRateLimitError,
  AuthenticationError,
  PermissionError,
  ResourceNotFoundError,
} from '@chat-adapter/shared'
import type { LarkAdapterConfig, LarkCardBody, LarkFileType, LarkSdkError } from './types.ts'

type ApiLogger = {
  debug(...args: unknown[]): void
  error(...args: unknown[]): void
  info(...args: unknown[]): void
  warn(...args: unknown[]): void
}

const ADAPTER_NAME = 'lark'
const HTTP_RATE_LIMIT = 429
const HTTP_UNAUTHORIZED = 401
const HTTP_FORBIDDEN = 403
const HTTP_NOT_FOUND = 404
const LARK_RATE_LIMIT_CODE = 99991400
const DEFAULT_PAGE_SIZE = 20

const extractStatus = (err: LarkSdkError): number | undefined =>
  err.response?.status ?? err.httpCode ?? err.status

const extractCode = (err: LarkSdkError): number | undefined => err.code ?? err.response?.data?.code

const matchLarkError = (
  status: number | undefined,
  code: number | undefined,
): Error | undefined => {
  if (status === HTTP_RATE_LIMIT || code === LARK_RATE_LIMIT_CODE) {
    return new AdapterRateLimitError(ADAPTER_NAME)
  }
  if (status === HTTP_UNAUTHORIZED) {
    return new AuthenticationError(ADAPTER_NAME)
  }
  if (status === HTTP_FORBIDDEN) {
    return new PermissionError(ADAPTER_NAME, 'access resource')
  }
  if (status === HTTP_NOT_FOUND) {
    return new ResourceNotFoundError(ADAPTER_NAME, 'resource')
  }
  return undefined
}

const mapError = (error: unknown): Error => {
  const err = error as LarkSdkError
  const matched = matchLarkError(extractStatus(err), extractCode(err))
  if (matched) {
    return matched
  }
  if (error instanceof Error) {
    return error
  }
  return new Error(String(error))
}

const bridgeLogger = (logger: ApiLogger) => ({
  debug: logger.debug.bind(logger),
  error: logger.error.bind(logger),
  info: logger.info.bind(logger),
  trace: logger.debug.bind(logger),
  warn: logger.warn.bind(logger),
})

class LarkApiClient {
  readonly client: Client

  constructor(
    config: Pick<
      LarkAdapterConfig,
      'appId' | 'appSecret' | 'appType' | 'cache' | 'disableTokenCache' | 'domain' | 'httpInstance'
    >,
    logger?: ApiLogger,
  ) {
    const base = {
      appId: config.appId,
      appSecret: config.appSecret,
      appType: config.appType ?? AppType.SelfBuild,
      cache: config.cache,
      disableTokenCache: config.disableTokenCache,
      domain: config.domain ?? Domain.Feishu,
      httpInstance: config.httpInstance,
    }

    if (logger) {
      this.client = new Client({
        ...base,
        logger: bridgeLogger(logger),
        loggerLevel: LoggerLevel.debug,
      })
    } else {
      this.client = new Client({ ...base, loggerLevel: LoggerLevel.error })
    }
  }

  async sendMessage(chatId: string, msgType: string, content: string) {
    return this.call(() =>
      this.client.im.message.create({
        data: { content, msg_type: msgType, receive_id: chatId },
        params: { receive_id_type: 'chat_id' },
      }),
    )
  }

  async replyMessage(messageId: string, msgType: string, content: string, replyInThread?: boolean) {
    return this.call(() =>
      this.client.im.message.reply({
        data: { content, msg_type: msgType, reply_in_thread: replyInThread },
        path: { message_id: messageId },
      }),
    )
  }

  async updateMessage(messageId: string, msgType: string, content: string) {
    return this.call(() =>
      this.client.im.message.update({
        data: { content, msg_type: msgType },
        path: { message_id: messageId },
      }),
    )
  }

  async patchCard(messageId: string, content: string) {
    return this.call(() =>
      this.client.im.message.patch({
        data: { content },
        path: { message_id: messageId },
      }),
    )
  }

  async deleteMessage(messageId: string) {
    return this.call(() => this.client.im.message.delete({ path: { message_id: messageId } }))
  }

  async getMessage(messageId: string) {
    return this.call(() => this.client.im.message.get({ path: { message_id: messageId } }))
  }

  async listMessages(
    containerId: string,
    containerType: 'chat' | 'thread' = 'chat',
    pageToken?: string,
    pageSize?: number,
    sortType?: 'ByCreateTimeAsc' | 'ByCreateTimeDesc',
  ) {
    return this.call(() =>
      this.client.im.message.list({
        params: {
          container_id: containerId,
          container_id_type: containerType,
          page_size: pageSize ?? DEFAULT_PAGE_SIZE,
          page_token: pageToken,
          sort_type: sortType,
        },
      }),
    )
  }

  async addReaction(messageId: string, emojiType: string) {
    return this.call(() =>
      this.client.im.messageReaction.create({
        data: { reaction_type: { emoji_type: emojiType } },
        path: { message_id: messageId },
      }),
    )
  }

  async removeReaction(messageId: string, reactionId: string) {
    return this.call(() =>
      this.client.im.messageReaction.delete({
        path: { message_id: messageId, reaction_id: reactionId },
      }),
    )
  }

  async listReactions(messageId: string) {
    return this.call(() => this.client.im.messageReaction.list({ path: { message_id: messageId } }))
  }

  async getChatInfo(chatId: string) {
    return this.call(() => this.client.im.chat.get({ path: { chat_id: chatId } }))
  }

  async createP2PChat(userId: string) {
    return this.call(() =>
      this.client.im.chat.create({
        data: { chat_mode: 'p2p', user_id_list: [userId] },
        params: { user_id_type: 'open_id' },
      }),
    )
  }

  async uploadImage(image: Buffer) {
    return this.call(() =>
      this.client.im.image.create({
        data: { image, image_type: 'message' },
      }),
    )
  }

  async uploadFile(file: Buffer, fileName: string, fileType: LarkFileType) {
    return this.call(() =>
      this.client.im.file.create({
        data: { file, file_name: fileName, file_type: fileType },
      }),
    )
  }

  async downloadResource(
    messageId: string,
    fileKey: string,
    type: 'file' | 'image',
  ): Promise<{ getReadableStream: () => import('node:stream').Readable }> {
    return this.call(() =>
      this.client.im.messageResource.get({
        path: { message_id: messageId, file_key: fileKey },
        params: { type },
      }),
    ) as Promise<{ getReadableStream: () => import('node:stream').Readable }>
  }

  async getBotInfo(): Promise<{ bot?: { app_name?: string; open_id?: string } }> {
    return this.call(() =>
      this.client.request({ method: 'GET', url: '/open-apis/bot/v3/info' }),
    ) as Promise<{ bot?: { app_name?: string; open_id?: string } }>
  }

  async getUser(openId: string): Promise<{ data?: { user?: { name?: string } } }> {
    return this.call(() =>
      this.client.contact.user.get({
        path: { user_id: openId },
        params: { user_id_type: 'open_id' },
      }),
    ) as Promise<{ data?: { user?: { name?: string } } }>
  }

  async sendEphemeral(chatId: string, userId: string, card: LarkCardBody) {
    return this.call(() =>
      this.client.request({
        data: { card, chat_id: chatId, msg_type: 'interactive', open_id: userId },
        method: 'POST',
        url: '/open-apis/ephemeral/v1/send',
      }),
    )
  }

  async createCard(cardJson: string) {
    return this.call(() =>
      this.client.cardkit.v1.card.create({
        data: { data: cardJson, type: 'card_json' },
      }),
    )
  }

  async streamUpdateText(opts: {
    cardId: string
    content: string
    elementId: string
    sequence: number
  }) {
    return this.call(() =>
      this.client.cardkit.v1.cardElement.content({
        data: { content: opts.content, sequence: opts.sequence },
        path: { card_id: opts.cardId, element_id: opts.elementId },
      }),
    )
  }

  async updateCardSettings(cardId: string, settings: string, sequence: number) {
    return this.call(() =>
      this.client.cardkit.v1.card.settings({
        data: { sequence, settings },
        path: { card_id: cardId },
      }),
    )
  }

  private async call<Result>(fn: () => Promise<Result>): Promise<Result> {
    let result: Result
    try {
      result = await fn()
    } catch (error: unknown) {
      throw mapError(error)
    }
    const code = (result as { code?: number } | null)?.code
    if (typeof code === 'number' && code !== 0) {
      const matched = matchLarkError(undefined, code)
      if (matched) throw matched
      const msg = (result as { msg?: string } | null)?.msg ?? 'unknown'
      throw new AdapterError(`Lark API error ${code}: ${msg}`, ADAPTER_NAME, String(code))
    }
    return result
  }
}

export { LarkApiClient }
