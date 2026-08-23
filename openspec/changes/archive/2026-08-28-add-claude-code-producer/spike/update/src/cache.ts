/**
 * Fixed-capacity LRU cache. Eviction order is maintained by re-inserting a
 * key on every get/set, so Map's own insertion order doubles as recency.
 */
export class LruCache<V> {
  private readonly map = new Map<string, V>();

  constructor(private readonly capacity: number) {
    if (capacity <= 0) throw new Error("capacity must be positive");
  }

  get(key: string): V | undefined {
    if (!this.map.has(key)) return undefined;
    const value = this.map.get(key) as V;
    this.map.delete(key);
    this.map.set(key, value); // move to most-recently-used
    return value;
  }

  set(key: string, value: V): void {
    if (this.map.has(key)) this.map.delete(key);
    else if (this.map.size >= this.capacity) {
      const oldest = this.map.keys().next().value as string;
      this.map.delete(oldest);
    }
    this.map.set(key, value);
  }

  has(key: string): boolean {
    return this.map.has(key);
  }

  get size(): number {
    return this.map.size;
  }
}
