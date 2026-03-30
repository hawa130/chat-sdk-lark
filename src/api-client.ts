import { AppType, Client, Domain } from '@larksuiteoapi/node-sdk'
import type { LarkAdapterConfig, LarkFileType, LarkSdkError } from './types.ts'

const HTTP_RATE_LIMIT = 429
const HTTP_UNAUTHORIZED = 401
const HTTP_FORBIDDEN = 403
const HTTP_NOT_FOUND = 404
const LARK_AUTH_CODE_A = 99991671
const LARK_AUTH_CODE_B = 99991663
const LARK_NETWORK_CODE = 99991
const DEFAULT_PAGE_SIZE = 20

const makeError = (message: string, name: string): Error =>
  Object.assign(new Error(message), { name })

const extractStatus = (err: LarkSdkError): number | undefined =>
  err.response?.status ?? err.httpCode ?? err.status

const extractCode = (err: LarkSdkError): number | undefined => err.code ?? err.response?.data?.code

const isAuthError = (status: number | undefined, code: number | undefined): boolean =>
  status === HTTP_UNAUTHORIZED ||
  status === HTTP_FORBIDDEN ||
  code === LARK_AUTH_CODE_A ||
  code === LARK_AUTH_CODE_B

const mapError = (error: unknown): Error => {
  const err = error as LarkSdkError
  const status = extractStatus(err)
  const code = extractCode(err)
  const mapped =
    (status === HTTP_RATE_LIMIT && makeError('Rate limit exceeded', 'AdapterRateLimitError')) ||
    (isAuthError(status, code) && makeError('Authentication failed', 'AuthenticationError')) ||
    (status === HTTP_NOT_FOUND && makeError('Resource not found', 'ResourceNotFoundError')) ||
    (code === LARK_NETWORK_CODE && makeError('Network error', 'NetworkError')) ||
    (error instanceof Error && error) ||
    new Error(String(error))
  return mapped
}

class LarkApiClient {
  readonly client: Client

  constructor(
    config: Pick<LarkAdapterConfig, 'appId' | 'appSecret' | 'domain' | 'disableTokenCache'>,
  ) {
    this.client = new Client({
      appId: config.appId,
      appSecret: config.appSecret,
      appType: AppType.SelfBuild,
      disableTokenCache: config.disableTokenCache,
      domain: config.domain ?? Domain.Feishu,
    })
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
