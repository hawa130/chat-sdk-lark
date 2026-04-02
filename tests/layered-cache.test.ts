import { describe, expect, it, vi } from 'vitest'
import type { StateAdapter } from 'chat'
import { LayeredCache } from '../src/layered-cache.ts'

const makeState = () =>
  ({
    get: vi.fn().mockResolvedValue(null),
    set: vi.fn().mockResolvedValue(undefined),
  }) as unknown as Pick<StateAdapter, 'get' | 'set'>

describe('LayeredCache', () => {
  it('reads from memory first and hydrates memory from state', async () => {
    const state = makeState()
    const cache = new LayeredCache<string>({
      keyPrefix: 'lark:user:',
      state,
    })

    await cache.set('ou_user1', 'Memory Alice', { ttlMs: 1000 })
    expect(cache.peek('ou_user1')).toBe('Memory Alice')
    expect(await cache.get('ou_user1')).toBe('Memory Alice')
    expect(state.get).not.toHaveBeenCalled()

    cache.clear()
    vi.mocked(state.get).mockResolvedValueOnce('State Alice')

    expect(await cache.get('ou_user1')).toBe('State Alice')
    expect(cache.peek('ou_user1')).toBe('State Alice')
    expect(state.get).toHaveBeenCalledWith('lark:user:ou_user1')
  })

  it('deduplicates concurrent resolves and caches the loaded value', async () => {
    const state = makeState()
    const cache = new LayeredCache<string>({
      keyPrefix: 'lark:user:',
      state,
    })
    const loader = vi.fn(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10))
      return 'Fetched Alice'
    })

    const [first, second] = await Promise.all([
      cache.resolve('ou_user1', {
        loader,
        ttlMs: 1000,
      }),
      cache.resolve('ou_user1', {
        loader,
        ttlMs: 1000,
      }),
    ])

    expect(first).toBe('Fetched Alice')
    expect(second).toBe('Fetched Alice')
    expect(loader).toHaveBeenCalledTimes(1)
    expect(state.set).toHaveBeenCalledWith('lark:user:ou_user1', 'Fetched Alice', 1000)
  })

  it('supports fallback values and failure ttl in resolve', async () => {
    const state = makeState()
    const cache = new LayeredCache<string>({
      keyPrefix: 'lark:user:',
      state,
    })

    await expect(
      cache.resolve('ou_user1', {
        failureTtlMs: 500,
        fallbackValue: 'ou_user1',
        loader: async () => {
          throw new Error('boom')
        },
        ttlMs: 1000,
      }),
    ).resolves.toBe('ou_user1')

    expect(state.set).toHaveBeenCalledWith('lark:user:ou_user1', 'ou_user1', 500)
  })
})
