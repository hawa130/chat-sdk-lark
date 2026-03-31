import { AppType, Client, Domain, LoggerLevel } from '@larksuiteoapi/node-sdk'
import {
  AdapterRateLimitError,
  AuthenticationError,
  PermissionError,
  ResourceNotFoundError,
} from '@chat-adapter/shared'
import type { LarkAdapterConfig, LarkFileType, LarkSdkError } from './types.ts'

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
const LARK_INVALID_ACCESS_TOKEN = 99991663
const LARK_INVALID_TOKEN_FORMAT = 99991671
const DEFAULT_PAGE_SIZE = 20

const extractStatus = (err: LarkSdkError): number | undefined =>
  err.response?.status ?? err.httpCode ?? err.status

const extractCode = (err: LarkSdkError): number | undefined => err.code ?? err.response?.data?.code

const isRateLimit = (status: number | undefined, code: number | undefined): boolean =>
  status === HTTP_RATE_LIMIT || code === LARK_RATE_LIMIT_CODE

const isAuthError = (status: number | undefined, code: number | undefined): boolean =>
  status === HTTP_UNAUTHORIZED ||
  code === LARK_INVALID_ACCESS_TOKEN ||
  code === LARK_INVALID_TOKEN_FORMAT

const matchLarkError = (
  status: number | undefined,
  code: number | undefined,
): Error | undefined => {
  if (isRateLimit(status, code)) {
    return new AdapterRateLimitError(ADAPTER_NAME)
  }
  if (isAuthError(status, code)) {
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
    config: Pick<LarkAdapterConfig, 'appId' | 'appSecret' | 'domain' | 'disableTokenCache'>,
    logger?: ApiLogger,
  ) {
    const base = {
      appId: config.appId,
      appSecret: config.appSecret,
      appType: AppType.SelfBuild as const,
      disableTokenCache: config.disableTokenCache,
      domain: config.domain ?? Domain.Feishu,
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

  async replyMessage(messageId: string, msgType: string, content: string) {
    return this.call(() =>
      this.client.im.message.reply({
        data: { content, msg_type: msgType },
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

  async deleteMessage(messageId: string) {
    return this.call(() => this.client.im.message.delete({ path: { message_id: messageId } }))
  }

  async getMessage(messageId: string) {
    return this.call(() => this.client.im.message.get({ path: { message_id: messageId } }))
  }

  async listMessages(chatId: string, pageToken?: string, pageSize?: number) {
    return this.call(() =>
      this.client.im.message.list({
        params: {
          container_id: chatId,
          container_id_type: 'chat',
          page_size: pageSize ?? DEFAULT_PAGE_SIZE,
          page_token: pageToken,
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

  async getBotInfo() {
    const res = await this.call(() =>
      this.client.request({ method: 'GET', url: '/open-apis/bot/v3/info' }),
    )
    return res as { bot?: { app_name?: string; open_id?: string } }
  }

  async sendEphemeral(chatId: string, userId: string, content: string) {
    return this.call(() =>
      this.client.request({
        data: { card: content, chat_id: chatId, msg_type: 'interactive', open_id: userId },
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
    try {
      return await fn()
    } catch (error: unknown) {
      throw mapError(error)
    }
  }
}

export default LarkApiClient
