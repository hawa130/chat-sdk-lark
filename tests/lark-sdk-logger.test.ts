import type { Logger } from 'chat'
import { describe, expect, it } from 'vitest'
import { createLarkSdkLogger } from '../src/lark-sdk-logger.ts'

interface LogRecord {
  args: unknown[]
  level: 'debug' | 'error' | 'info' | 'warn'
  message: string
  prefix: string
}

const createRecordingLogger = (records: LogRecord[], prefix = 'chat-sdk:lark'): Logger => ({
  child: (childPrefix: string) => createRecordingLogger(records, `${prefix}:${childPrefix}`),
  debug: (message: string, ...args: unknown[]) => {
    records.push({ args, level: 'debug', message, prefix })
  },
  error: (message: string, ...args: unknown[]) => {
    records.push({ args, level: 'error', message, prefix })
  },
  info: (message: string, ...args: unknown[]) => {
    records.push({ args, level: 'info', message, prefix })
  },
  warn: (message: string, ...args: unknown[]) => {
    records.push({ args, level: 'warn', message, prefix })
  },
})

describe('createLarkSdkLogger', () => {
  it('formats SDK array payloads into readable lines and preserves metadata', () => {
    const records: LogRecord[] = []
    const logger = createLarkSdkLogger(createRecordingLogger(records))

    logger.info(['[ws]', 'ws client ready', { attempt: 1 }])

    expect(records).toEqual([
      {
        args: [{ attempt: 1 }],
        level: 'info',
        message: 'ws client ready',
        prefix: 'chat-sdk:lark:sdk:ws',
      },
    ])
  })

  it('preserves multiline text and falls back to a default message for metadata-only logs', () => {
    const records: LogRecord[] = []
    const logger = createLarkSdkLogger(createRecordingLogger(records))
    const error = new Error('boom')

    logger.warn(['[ws]', 'line 1\nline 2'])
    logger.error([error, { code: 500 }])

    expect(records).toEqual([
      {
        args: [],
        level: 'warn',
        message: 'line 1\nline 2',
        prefix: 'chat-sdk:lark:sdk:ws',
      },
      {
        args: [error, { code: 500 }],
        level: 'error',
        message: 'Lark SDK log',
        prefix: 'chat-sdk:lark:sdk',
      },
    ])
  })

  it('maps trace logs to debug and recognizes bare ws scopes', () => {
    const records: LogRecord[] = []
    const logger = createLarkSdkLogger(createRecordingLogger(records))

    logger.trace(['ws', 'ping success'])

    expect(records).toEqual([
      {
        args: [],
        level: 'debug',
        message: 'ping success',
        prefix: 'chat-sdk:lark:sdk:ws',
      },
    ])
  })

  it('summarizes axios-style lark api errors into a readable line', () => {
    const records: LogRecord[] = []
    const logger = createLarkSdkLogger(createRecordingLogger(records))

    logger.error([
      {
        config: {
          method: 'post',
          url: 'https://open.feishu.cn/open-apis/im/v1/messages/om_123/reactions',
        },
        message: 'Request failed with status code 400',
        response: {
          status: 400,
          statusText: 'Bad Request',
        },
      },
      {
        code: 231001,
        log_id: '20260402164115E5185F5428F683700A71',
        msg: 'reaction type is invalid.',
        troubleshooter:
          'https://open.feishu.cn/search?from=openapi&log_id=20260402164115E5185F5428F683700A71',
      },
    ])

    expect(records).toEqual([
      {
        args: [
          {
            code: 231001,
            logId: '20260402164115E5185F5428F683700A71',
            status: 400,
            troubleshooter:
              'https://open.feishu.cn/search?from=openapi&log_id=20260402164115E5185F5428F683700A71',
          },
        ],
        level: 'error',
        message:
          'HTTP 400 POST /open-apis/im/v1/messages/om_123/reactions -> Lark API 231001: reaction type is invalid.',
        prefix: 'chat-sdk:lark:sdk',
      },
    ])
  })
})
