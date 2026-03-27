/** FIFO dedup cache with fixed capacity. Used to deduplicate Lark event re-deliveries. */
export default class DedupCache {
  private readonly capacity: number
  private readonly set = new Set<string>()
  private readonly queue: string[] = []

  constructor(capacity: number) {
    this.capacity = capacity
  }

  has(key: string): boolean {
    return this.set.has(key)
  }

  add(key: string): void {
    if (this.set.has(key)) {
      return
    }
    if (this.queue.length >= this.capacity) {
      const evicted = this.queue.shift()!
      this.set.delete(evicted)
    }
    this.set.add(key)
    this.queue.push(key)
  }

  clear(): void {
    this.set.clear()
    this.queue.length = 0
  }
}
