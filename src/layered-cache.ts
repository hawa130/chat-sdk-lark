import type { StateAdapter } from 'chat'

interface LayeredCacheOptions {
  keyPrefix: string
  state?: Pick<StateAdapter, 'get' | 'set'> | null
}

interface LayeredCacheResolveOptions<T> {
  failureTtlMs?: number
  fallbackValue?: T
  loader: () => Promise<T>
  onError?: (error: unknown) => void
  ttlMs?: number
}

class LayeredCache<T> {
  private readonly inFlight = new Map<string, Promise<T>>()
  private readonly keyPrefix: string
  private readonly memory = new Map<string, T>()
  private state: Pick<StateAdapter, 'get' | 'set'> | null

  constructor(options: LayeredCacheOptions) {
    this.keyPrefix = options.keyPrefix
    this.state = options.state ?? null
  }

  setState(state: Pick<StateAdapter, 'get' | 'set'> | null): void {
    this.state = state
  }

  clear(): void {
    this.inFlight.clear()
    this.memory.clear()
  }

  peek(key: string): T | undefined {
    return key ? this.memory.get(key) : undefined
  }

  async get(key: string): Promise<T | null> {
    if (!key) {
      return null
    }

    const inMemory = this.memory.get(key)
    if (inMemory !== undefined) {
      return inMemory
    }

    const fromState = await this.state?.get<T>(this.toStateKey(key))
    if (fromState !== null && fromState !== undefined) {
      this.memory.set(key, fromState)
      return fromState
    }

    return null
  }

  async set(key: string, value: T, options?: { ttlMs?: number }): Promise<void> {
    if (!key) {
      return
    }

    this.memory.set(key, value)
    await this.state?.set<T>(this.toStateKey(key), value, options?.ttlMs)
  }

  async resolve(key: string, options: LayeredCacheResolveOptions<T>): Promise<T> {
    const cached = await this.get(key)
    if (cached !== null) {
      return cached
    }

    const pending = this.inFlight.get(key)
    if (pending) {
      return pending
    }

    const task = this.loadAndCache(key, options).finally(() => {
      this.inFlight.delete(key)
    })
    this.inFlight.set(key, task)
    return task
  }

  private async loadAndCache(key: string, options: LayeredCacheResolveOptions<T>): Promise<T> {
    try {
      const loaded = await options.loader()
      await this.set(key, loaded, { ttlMs: options.ttlMs })
      return loaded
    } catch (error) {
      options.onError?.(error)
      if (options.fallbackValue !== undefined) {
        await this.set(key, options.fallbackValue, { ttlMs: options.failureTtlMs })
        return options.fallbackValue
      }
      throw error
    }
  }

  private toStateKey(key: string): string {
    return `${this.keyPrefix}${key}`
  }
}

export { LayeredCache }
export type { LayeredCacheOptions, LayeredCacheResolveOptions }
