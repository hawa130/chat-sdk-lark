import { afterEach, describe, expect, it, vi } from 'vitest'

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
})
