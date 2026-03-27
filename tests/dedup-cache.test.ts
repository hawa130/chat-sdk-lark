import { describe, expect, it } from 'vitest'
import DedupCache from '../src/dedup-cache.ts'

const LARGE_CAPACITY = 100
const SMALL_CAPACITY = 3
const TINY_CAPACITY = 2

describe('DedupCache', () => {
  it('returns false for unseen keys', () => {
    const cache = new DedupCache(LARGE_CAPACITY)
    expect(cache.has('event-1')).toBe(false)
  })

  it('returns true after adding a key', () => {
    const cache = new DedupCache(LARGE_CAPACITY)
    cache.add('event-1')
    expect(cache.has('event-1')).toBe(true)
  })

  it('evicts oldest entry when capacity is exceeded', () => {
    const cache = new DedupCache(SMALL_CAPACITY)
    cache.add('a')
    cache.add('b')
    cache.add('c')
    cache.add('d') // Evicts "a"
    expect(cache.has('a')).toBe(false)
    expect(cache.has('b')).toBe(true)
    expect(cache.has('d')).toBe(true)
  })

  it('is idempotent — adding same key twice does not consume capacity', () => {
    const cache = new DedupCache(TINY_CAPACITY)
    cache.add('a')
    cache.add('a')
    cache.add('b')
    expect(cache.has('a')).toBe(true)
    expect(cache.has('b')).toBe(true)
  })

  it('clear removes all entries', () => {
    const cache = new DedupCache(LARGE_CAPACITY)
    cache.add('x')
    cache.add('y')
    cache.clear()
    expect(cache.has('x')).toBe(false)
    expect(cache.has('y')).toBe(false)
  })
})
