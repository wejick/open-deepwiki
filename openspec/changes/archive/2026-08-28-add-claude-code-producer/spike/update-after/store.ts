import { LruCache } from "./cache.ts";

type Entry<V> = { value: V; expiresAt: number };

/**
 * TTL-aware key/value store layered over LruCache. Expiry is checked lazily
 * on read rather than with a timer, so an expired entry still occupies a
 * cache slot until it's next touched. An optional onEvict callback fires
 * with the unwrapped value when capacity forces an eviction.
 */
export class Store<V> {
  private readonly cache: LruCache<Entry<V>>;

  constructor(
    capacity: number,
    private readonly ttlMs: number,
    onEvict?: (key: string, value: V) => void,
  ) {
    this.cache = new LruCache(capacity, onEvict ? (k, entry) => onEvict(k, entry.value) : undefined);
  }

  get(key: string): V | undefined {
    const entry = this.cache.get(key);
    if (!entry) return undefined;
    if (Date.now() >= entry.expiresAt) return undefined;
    return entry.value;
  }

  set(key: string, value: V): void {
    this.cache.set(key, { value, expiresAt: Date.now() + this.ttlMs });
  }

  has(key: string): boolean {
    return this.get(key) !== undefined;
  }
}
