import { afterEach, describe, expect, it, vi } from 'vitest'
import { AppType, LoggerLevel } from '@larksuiteoapi/node-sdk'
import type { LarkAdapterConfig } from '../src/types.ts'

type AdapterWithConfig = {
  config: LarkAdapterConfig
}

describe('createLarkAdapter', () => {
  const originalEnv = { ...process.env }

  afterEach(() => {
    process.env = { ...originalEnv }
  })

  it('creates adapter with explicit config', async () => {
    const { createLarkAdapter } = await import('../src/factory.ts')
    const adapter = createLarkAdapter({ appId: 'app-123', appSecret: 'secret-456' })
    expect(adapter.name).toBe('lark')
  })

  it('falls back to environment variables', async () => {
    process.env.LARK_APP_ID = 'env-app-id'
    process.env.LARK_APP_SECRET = 'env-secret'
    const { createLarkAdapter } = await import('../src/factory.ts')
    const adapter = createLarkAdapter()
    expect(adapter.name).toBe('lark')
  })

  it('throws when appId is missing', async () => {
    delete process.env.LARK_APP_ID
    delete process.env.LARK_APP_SECRET
    const { createLarkAdapter } = await import('../src/factory.ts')
    expect(() => createLarkAdapter()).toThrow(/LARK_APP_ID/)
  })

  it('throws when appSecret is missing', async () => {
    process.env.LARK_APP_ID = 'app-id'
    delete process.env.LARK_APP_SECRET
    const { createLarkAdapter } = await import('../src/factory.ts')
    expect(() => createLarkAdapter()).toThrow(/LARK_APP_SECRET/)
  })

  it('config overrides environment variables', async () => {
    process.env.LARK_APP_ID = 'env-id'
    process.env.LARK_APP_SECRET = 'env-secret'
    const { createLarkAdapter } = await import('../src/factory.ts')
    const adapter = createLarkAdapter({ appId: 'config-id', appSecret: 'config-secret' })
    expect(adapter.name).toBe('lark')
  })

  it('reads LARK_DOMAIN=lark', async () => {
    process.env.LARK_APP_ID = 'id'
    process.env.LARK_APP_SECRET = 'secret'
    process.env.LARK_DOMAIN = 'lark'
    const { createLarkAdapter } = await import('../src/factory.ts')
    expect(() => createLarkAdapter()).not.toThrow()
  })

  it('reads LARK_ENCRYPT_KEY from env', async () => {
    process.env.LARK_APP_ID = 'id'
    process.env.LARK_APP_SECRET = 'secret'
    process.env.LARK_ENCRYPT_KEY = 'my-encrypt-key'
    const { createLarkAdapter } = await import('../src/factory.ts')
    expect(() => createLarkAdapter()).not.toThrow()
  })

  it('reads LARK_VERIFICATION_TOKEN from env', async () => {
    process.env.LARK_APP_ID = 'id'
    process.env.LARK_APP_SECRET = 'secret'
    process.env.LARK_VERIFICATION_TOKEN = 'my-verify-token'
    const { createLarkAdapter } = await import('../src/factory.ts')
    expect(() => createLarkAdapter()).not.toThrow()
  })

  it('LARK_DOMAIN=feishu uses default domain', async () => {
    process.env.LARK_APP_ID = 'id'
    process.env.LARK_APP_SECRET = 'secret'
    process.env.LARK_DOMAIN = 'feishu'
    const { createLarkAdapter } = await import('../src/factory.ts')
    expect(() => createLarkAdapter()).not.toThrow()
  })

  it('passes logger through to adapter', async () => {
    process.env.LARK_APP_ID = 'id'
    process.env.LARK_APP_SECRET = 'secret'
    const mockLogger = {
      child: () => mockLogger,
      debug: vi.fn(),
      error: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
    }
    const { createLarkAdapter } = await import('../src/factory.ts')
    expect(() => createLarkAdapter({ logger: mockLogger })).not.toThrow()
  })

  it('defaults incoming transport to webhook for events and callbacks', async () => {
    process.env.LARK_APP_ID = 'id'
    process.env.LARK_APP_SECRET = 'secret'
    const { createLarkAdapter } = await import('../src/factory.ts')
    const adapter = createLarkAdapter()
    const config = (adapter as unknown as AdapterWithConfig).config

    expect(config.incoming).toEqual({
      callbacks: 'webhook',
      events: 'webhook',
    })
  })

  it('fills missing incoming transport values with webhook defaults', async () => {
    process.env.LARK_APP_ID = 'id'
    process.env.LARK_APP_SECRET = 'secret'
    const { createLarkAdapter } = await import('../src/factory.ts')
    const adapter = createLarkAdapter({
      incoming: { events: 'ws' },
    })
    const config = (adapter as unknown as AdapterWithConfig).config

    expect(config.incoming).toEqual({
      callbacks: 'webhook',
      events: 'ws',
    })
  })

  it('passes ws config through to adapter', async () => {
    process.env.LARK_APP_ID = 'id'
    process.env.LARK_APP_SECRET = 'secret'
    const { createLarkAdapter } = await import('../src/factory.ts')
    const adapter = createLarkAdapter({
      ws: {
        autoReconnect: false,
        loggerLevel: LoggerLevel.debug,
      },
    })
    const config = (adapter as unknown as AdapterWithConfig).config

    expect(config.ws).toEqual({
      autoReconnect: false,
      loggerLevel: LoggerLevel.debug,
    })
  })

  it('rejects ws incoming transport for ISV apps', async () => {
    process.env.LARK_APP_ID = 'id'
    process.env.LARK_APP_SECRET = 'secret'
    const { createLarkAdapter } = await import('../src/factory.ts')

    expect(() =>
      createLarkAdapter({
        appType: AppType.ISV,
        incoming: { events: 'ws' },
      }),
    ).toThrow(/self-build|SelfBuild|ws/i)
  })
})
